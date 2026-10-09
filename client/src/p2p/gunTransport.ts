/**
 * `Transport` over GUN (docs/p2p-protocol.md §3.1, §7.3, §7.4, §11.2).
 *
 * * publish: `gun.get(soul).get(key).put(value)`; the promise resolves on the
 *   relay's acknowledgement (its storage wrote the value: the "relay echo").
 *   Unacknowledged puts are retried with backoff and again on every `hi`
 *   (GUN never pushes puts made while disconnected). A put rejected by SEA
 *   (wrong hash) rejects for good.
 * * puts are paced under the relay's per-connection limit (50 puts/s, burst 200, §8).
 * * subscribe: one shared GUN subscription per soul (SubscriptionManager).
 * * synced(soul): resolves once the relay answered a re-ask of the soul and
 *   the answer went quiet (best effort, bounded).
 * * rebuild(): a fresh GUN instance carrying only the souls still watched
 *   (§7.3: never `.off()`).
 */
import type { Hex32, Transport } from '@avalon/common/protocol';
import { createGun, type GunAck, type GunHandle, type SeaPair } from './gun.ts';
import { Listeners, realTimers, type TimerHandle, type Timers } from './env.ts';
import { SubscriptionManager, type Unsub } from './subscriptions.ts';

export interface GunTransportOptions {
  relayUrl: string;
  /** Creates the GUN handle (default: createGun(relayUrl)). */
  createHandle?: (relayUrl: string) => GunHandle;
  timers?: Timers;
  /** Pacing of puts (default 40/s, burst 100: below the relay's 50/s, burst 200). */
  rate?: { perSecond: number; burst: number };
  /** Time without an acknowledgement before a put is re-sent (default 10 s). */
  ackTimeoutMs?: number;
}

interface Entry {
  soul: string;
  key: Hex32;
  value: string;
  echoed: boolean;
  attempts: number;
  /** Generation of the current send (stale acks are ignored). */
  gen: number;
  queued: boolean;
  timer: TimerHandle | null;
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: Error) => void;
  settled: boolean;
}

interface SoulWatch { cb: (key: string, value: string) => void; unsub: Unsub }
interface UserWatch { cb: (value: string) => void; unsub: Unsub }

const SYNC_QUIET_MS = 300;
const SYNC_MAX_MS = 5000;

/** SEA's rejection texts: permanent failures (retrying cannot help). */
function permanentError(err: string): boolean {
  return /hash|signature|unverified|invalid|not same/i.test(err);
}

export class GunTransport implements Transport {
  private handleValue: GunHandle;
  private subs: SubscriptionManager;
  private readonly makeHandle: (relayUrl: string) => GunHandle;
  private readonly relayUrl: string;
  private readonly timers: Timers;
  private readonly rate: { perSecond: number; burst: number };
  private readonly ackTimeoutMs: number;
  private readonly entries = new Map<string, Entry>();
  private readonly queue: Entry[] = [];
  private tokens: number;
  private lastRefill: number;
  private pumpTimer: TimerHandle | null = null;
  private readonly watchers = new Map<string, Set<SoulWatch>>();
  private readonly userWatchers = new Map<string, Set<UserWatch>>();
  private readonly handleUnsubs: (() => void)[] = [];
  private readonly hi = new Listeners<void>();
  private readonly bye = new Listeners<void>();
  private readonly replyWaiters = new Map<string, () => void>();
  private readonly soulWaiters = new Map<string, { soul: string; done: () => void }>();
  /** Souls for which a put arrived from the relay, per GUN instance. */
  private readonly answered = new WeakMap<GunHandle, Set<string>>();
  private authPair: SeaPair | null = null;
  private readonly userPuts = new Map<string, string>();
  private closed = false;
  /** Every soul subscribed through this transport, in order, across rebuilds (§9 checks). */
  readonly subscribedOrder: string[] = [];

  constructor(o: GunTransportOptions) {
    this.relayUrl = o.relayUrl;
    this.makeHandle = o.createHandle ?? ((url) => createGun(url));
    this.timers = o.timers ?? realTimers;
    this.rate = o.rate ?? { perSecond: 40, burst: 100 };
    this.ackTimeoutMs = o.ackTimeoutMs ?? 10000;
    this.tokens = this.rate.burst;
    this.lastRefill = this.timers.now();
    this.handleValue = this.makeHandle(this.relayUrl);
    this.subs = new SubscriptionManager(this.handleValue, () => this.timers.now());
    this.attach();
  }

  get handle(): GunHandle {
    return this.handleValue;
  }

  get subscriptions(): SubscriptionManager {
    return this.subs;
  }

  connected(): boolean {
    return !this.closed && this.handleValue.connected();
  }

  onHi(cb: () => void): () => void {
    return this.hi.add(cb);
  }

  onBye(cb: () => void): () => void {
    return this.bye.add(cb);
  }

  reconnect(): void {
    this.handleValue.reconnect();
  }

  // ------------------------------------------------------------ Transport

  publish(soul: string, key: Hex32, value: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error('transport closed'));
    const id = soul + '\u0000' + key;
    const existing = this.entries.get(id);
    if (existing !== undefined && existing.value === value) {
      if (existing.echoed || !existing.settled) return existing.promise;
    }
    let resolve: () => void = () => undefined;
    let reject: (e: Error) => void = () => undefined;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => undefined);
    const e: Entry = {
      soul, key, value, echoed: false, attempts: 0, gen: 0, queued: false, timer: null, promise, resolve, reject, settled: false,
    };
    this.entries.set(id, e);
    this.enqueue(e);
    return promise;
  }

  subscribe(soul: string, onValue: (key: string, value: string) => void): () => void {
    let set = this.watchers.get(soul);
    if (set === undefined) {
      set = new Set();
      this.watchers.set(soul, set);
    }
    this.subscribedOrder.push(soul);
    const sub: SoulWatch = { cb: onValue, unsub: () => undefined };
    set.add(sub);
    sub.unsub = this.subs.watch(soul, onValue);
    const s = set;
    return () => {
      s.delete(sub);
      sub.unsub();
    };
  }

  /**
   * Resolves once the relay answered a fresh re-ask of `soul` and no new value
   * arrived for a short quiet period (bounded; best effort when offline).
   */
  async synced(soul: string): Promise<void> {
    await this.syncedOk(soul);
  }

  /** Like synced(); resolves true only if the relay actually answered. */
  async syncedOk(soul: string): Promise<boolean> {
    if (this.closed) return false;
    if (!this.subs.isWatching(soul)) {
      const unsub = this.subscribe(soul, () => undefined);
      try {
        return await this.syncedOk(soul);
      } finally {
        unsub();
      }
    }
    const start = this.timers.now();
    while (!this.connected() && this.timers.now() - start < SYNC_MAX_MS && !this.closed) await this.sleep(100);
    if (!this.connected()) return false;
    const sub = this.subs;
    const handle = this.handleValue;
    const answeredBefore = this.answered.get(handle)?.has(soul) === true;
    const id = handle.reask(soul);
    let replied = false;
    const waiterDone = new Promise<void>((resolve) => {
      const done = (): void => {
        replied = true;
        resolve();
      };
      this.replyWaiters.set(id, done);
      this.soulWaiters.set(id, { soul, done });
    });
    // The relay does not repeat data it already sent on this connection: a soul it answered
    // before counts as answered once the re-ask went quiet.
    const quiet = answeredBefore ? this.sleep(SYNC_QUIET_MS).then(() => {
      replied = true;
    }) : this.sleep(SYNC_MAX_MS);
    await Promise.race([waiterDone, quiet, this.sleep(SYNC_MAX_MS)]);
    this.replyWaiters.delete(id);
    this.soulWaiters.delete(id);
    if (!replied) return false;
    const answeredAt = this.timers.now();
    for (;;) {
      const last = Math.max(answeredAt, sub.lastDelivery(soul));
      const quietFor = this.timers.now() - last;
      if (quietFor >= SYNC_QUIET_MS || this.timers.now() - start > 2 * SYNC_MAX_MS) return true;
      await this.sleep(SYNC_QUIET_MS - quietFor + 5);
    }
  }

  // ------------------------------------------------------------ extras

  /** True once the relay acknowledged this key (§7.4: only an echo counts as sent). */
  isEchoed(key: string, soul?: string): boolean {
    if (soul !== undefined) return this.entries.get(soul + '\u0000' + key)?.echoed === true;
    for (const e of this.entries.values()) if (e.key === key && e.echoed) return true;
    return false;
  }

  /** Forgets every echo (after a reconnect or a relay restart, everything is re-put). */
  resetEchoes(): void {
    for (const e of this.entries.values()) e.echoed = false;
  }

  /** Re-asks souls from the relay (§7.3). */
  reask(souls: Iterable<string>): void {
    if (!this.connected()) return;
    this.subs.reask(souls);
  }

  /** Souls currently watched. */
  activeSouls(): string[] {
    return [...this.watchers].filter(([, s]) => s.size > 0).map(([soul]) => soul);
  }

  /** Authenticates the GUN user for presence writes; repeated on every rebuilt instance. */
  auth(pair: SeaPair): Promise<void> {
    this.authPair = pair;
    return this.handleValue.auth(pair);
  }

  /** Forgets the authenticated user (logout): the next rebuild does not re-authenticate it. */
  forgetUser(): void {
    this.authPair = null;
    this.userPuts.clear();
  }

  /** Writes a key of the own user space (presence), once authenticated. */
  async putUser(key: string, value: string): Promise<void> {
    this.userPuts.set(key, value);
    const pair = this.authPair;
    if (pair === null) throw new Error('not authenticated');
    const h = this.handleValue;
    await h.auth(pair);
    if (h !== this.handleValue || this.closed) return;
    h.gun.user().get(key).put(value);
  }

  watchUser(pub: string, key: string, cb: (value: string) => void): () => void {
    const id = pub + '\u0000' + key;
    let set = this.userWatchers.get(id);
    if (set === undefined) {
      set = new Set();
      this.userWatchers.set(id, set);
    }
    const sub: UserWatch = { cb, unsub: () => undefined };
    set.add(sub);
    sub.unsub = this.subs.watchUser(pub, key, cb);
    const s = set;
    return () => {
      s.delete(sub);
      sub.unsub();
    };
  }

  /**
   * Replaces the GUN instance with a fresh one that subscribes only to the
   * souls still watched (§7.3), re-authenticates and re-sends unechoed puts.
   */
  rebuild(): void {
    if (this.closed) return;
    const old = this.handleValue;
    for (const u of this.handleUnsubs.splice(0)) u();
    this.handleValue = this.makeHandle(this.relayUrl);
    this.subs = new SubscriptionManager(this.handleValue, () => this.timers.now());
    this.attach();
    old.close();
    for (const [soul, set] of this.watchers) {
      for (const sub of set) sub.unsub = this.subs.watch(soul, sub.cb);
    }
    for (const [id, set] of this.userWatchers) {
      const [pub, key] = id.split('\u0000');
      for (const sub of set) sub.unsub = this.subs.watchUser(pub, key, sub.cb);
    }
    if (this.authPair !== null) {
      const pair = this.authPair;
      this.handleValue.auth(pair).then(() => {
        for (const [k, v] of this.userPuts) void this.putUser(k, v).catch(() => undefined);
      }).catch(() => undefined);
    }
    this.resendAll();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const u of this.handleUnsubs.splice(0)) u();
    this.timers.clearTimeout(this.pumpTimer);
    for (const e of this.entries.values()) {
      this.timers.clearTimeout(e.timer);
      if (!e.settled) {
        e.settled = true;
        e.reject(new Error('transport closed'));
      }
    }
    this.handleValue.close();
  }

  // ------------------------------------------------------------ internals

  private attach(): void {
    const h = this.handleValue;
    this.handleUnsubs.push(h.onHi(() => {
      this.resendAll();
      this.hi.emit();
    }));
    this.handleUnsubs.push(h.onBye(() => this.bye.emit()));
    this.handleUnsubs.push(h.onIn((msg) => {
      const at = msg['@'];
      if (typeof at === 'string') {
        const w = this.replyWaiters.get(at);
        if (w !== undefined) w();
      }
      const put = msg.put;
      if (typeof put === 'object' && put !== null) {
        let set = this.answered.get(h);
        if (set === undefined) {
          set = new Set();
          this.answered.set(h, set);
        }
        for (const soul of Object.keys(put)) {
          set.add(soul);
          for (const w of [...this.soulWaiters.values()]) if (w.soul === soul) w.done();
        }
      }
    }));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timers.setTimeout(resolve, ms);
    });
  }

  /** Re-sends every unacknowledged put (on hi / rebuild). */
  private resendAll(): void {
    for (const e of this.entries.values()) {
      if (e.echoed || e.settled) continue;
      this.timers.clearTimeout(e.timer);
      e.timer = null;
      this.enqueue(e);
    }
  }

  private enqueue(e: Entry): void {
    if (e.queued || this.closed) return;
    e.queued = true;
    this.queue.push(e);
    this.pump();
  }

  private refill(): void {
    const now = this.timers.now();
    const dt = Math.max(0, now - this.lastRefill);
    this.lastRefill = now;
    this.tokens = Math.min(this.rate.burst, this.tokens + (dt * this.rate.perSecond) / 1000);
  }

  private pump(): void {
    if (this.pumpTimer !== null || this.closed) return;
    this.refill();
    while (this.queue.length > 0 && this.tokens >= 1) {
      const e = this.queue.shift();
      if (e === undefined) break;
      e.queued = false;
      if (e.echoed || e.settled) continue;
      this.tokens -= 1;
      this.send(e);
    }
    if (this.queue.length > 0) {
      const wait = Math.ceil(((1 - this.tokens) * 1000) / this.rate.perSecond) + 1;
      this.pumpTimer = this.timers.setTimeout(() => {
        this.pumpTimer = null;
        this.pump();
      }, wait);
    }
  }

  private send(e: Entry): void {
    const gen = ++e.gen;
    e.attempts++;
    const h = this.handleValue;
    h.gun.get(e.soul).get(e.key).put(e.value, (ack: GunAck) => this.onAck(e, gen, ack));
    this.timers.clearTimeout(e.timer);
    // Our own timer: GUN's "No ACK yet" arrives after 9 s, but not if the instance was replaced.
    e.timer = this.timers.setTimeout(() => {
      e.timer = null;
      if (e.gen !== gen || e.echoed || e.settled) return;
      this.retryLater(e);
    }, this.ackTimeoutMs);
  }

  private onAck(e: Entry, gen: number, ack: GunAck): void {
    if (e.settled && !e.echoed) return;
    if (ack.err === undefined && ack.ok !== undefined && ack.ok !== false && ack.ok !== null) {
      e.echoed = true;
      this.timers.clearTimeout(e.timer);
      e.timer = null;
      if (!e.settled) {
        e.settled = true;
        e.resolve();
      }
      return;
    }
    if (gen !== e.gen) return;
    if (typeof ack.err === 'string' && !ack.lack && permanentError(ack.err)) {
      this.timers.clearTimeout(e.timer);
      e.timer = null;
      if (!e.settled) {
        e.settled = true;
        e.reject(new Error(ack.err));
      }
      this.entries.delete(e.soul + '\u0000' + e.key);
      return;
    }
    this.retryLater(e);
  }

  private retryLater(e: Entry): void {
    if (e.echoed || e.settled || this.closed) return;
    this.timers.clearTimeout(e.timer);
    // While offline the put waits for the next `hi` (resendAll).
    if (!this.connected()) {
      e.timer = null;
      return;
    }
    const delay = Math.min(30000, 1000 * 2 ** Math.min(5, e.attempts));
    e.timer = this.timers.setTimeout(() => {
      e.timer = null;
      this.enqueue(e);
    }, delay);
  }
}
