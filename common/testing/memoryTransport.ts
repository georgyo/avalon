/**
 * MemoryTransport (docs/p2p-protocol.md §11.2, §12): a shared in-memory
 * "relay" with a deterministic virtual clock. Every publish and delivery is an
 * event in a seeded priority queue; `run()` processes events one at a time and
 * waits for the peers to become idle in between, so a simulation is a pure
 * function of its seeds.
 *
 * Network behaviour: random delays, reordering, duplication and drops (a
 * dropped delivery is retried later: the transport "retries internally", so
 * delivery between online peers is eventual), partitions (a value reaches only
 * the peers in its publisher's group until `heal()`), `restartEmpty()` (the
 * relay loses its store; peers are notified after 0-5 s, like a new bootId).
 */
import { sha256, u32, utf8, concat } from '../crypto/bytes.ts';
import type { Hex32, Transport } from '../protocol/types.ts';

export interface MemoryTransportOptions {
  seed?: number;
  delayMs?: [number, number];
  dropRate?: number;
  duplicateRate?: number;
  reorder?: boolean;
}

interface QEvent { time: number; seq: number; fn: () => void }

/** A deterministic PRNG in [0, 1) from SHA-256 in counter mode. */
export function seededRng(...seed: (number | string)[]): () => number {
  const prefix = concat(...seed.map((s) => (typeof s === 'number' ? u32(s >>> 0) : utf8(s))));
  let counter = 0;
  let buf: Uint8Array = new Uint8Array(0);
  let pos = 0;
  return () => {
    if (pos + 4 > buf.length) {
      buf = sha256(prefix, u32(counter++));
      pos = 0;
    }
    const v = ((buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]) >>> 0;
    pos += 4;
    return v / 4294967296;
  };
}

interface Sub { peer: MemPeer; soul: string; cb: (key: string, value: string) => void; active: boolean }

interface Entry { value: string; groups: Set<number>; all: boolean }

/** A peer's handle on the relay. */
export class MemPeer implements Transport {
  readonly id: number;
  private readonly net: MemoryTransport;
  /** Souls this peer subscribed to, in order (non-interference checks, §12). */
  readonly subscribed: string[] = [];
  private restartListeners: (() => void)[] = [];
  /** Per-peer drop filter for deliveries to this peer: return true to drop that delivery attempt once. */
  dropIncoming: ((soul: string, key: string, value: string) => boolean) | null = null;
  /** When false, the peer is offline: its publishes and deliveries wait until it is online again. */
  online = true;

  constructor(net: MemoryTransport, id: number) {
    this.net = net;
    this.id = id;
  }

  publish(soul: string, key: Hex32, value: string): Promise<void> {
    return this.net.publishFrom(this, soul, key, value);
  }

  subscribe(soul: string, onValue: (key: string, value: string) => void): () => void {
    this.subscribed.push(soul);
    return this.net.subscribeFrom(this, soul, onValue);
  }

  /** Called (after a random delay) when the relay restarted empty. */
  onRestart(cb: () => void): () => void {
    this.restartListeners.push(cb);
    return () => {
      this.restartListeners = this.restartListeners.filter((x) => x !== cb);
    };
  }

  notifyRestart(): void {
    for (const cb of [...this.restartListeners]) cb();
  }
}

export class MemoryTransport {
  /** Virtual time in ms. */
  now = 0;
  readonly opts: Required<MemoryTransportOptions>;
  private readonly rng: () => number;
  private readonly queue: QEvent[] = [];
  private seq = 0;
  private epoch = 0;
  private readonly store = new Map<string, Map<string, Entry>>();
  private readonly peers: MemPeer[] = [];
  private readonly subs: Sub[] = [];
  private groupOf: Map<MemPeer, number> | null = null;
  private readonly delivered = new Map<MemPeer, Set<string>>();
  /** Number of events processed by run(). */
  events = 0;

  constructor(o?: MemoryTransportOptions) {
    this.opts = {
      seed: o?.seed ?? 1,
      delayMs: o?.delayMs ?? [1, 20],
      dropRate: o?.dropRate ?? 0,
      duplicateRate: o?.duplicateRate ?? 0,
      reorder: o?.reorder ?? true,
    };
    this.rng = seededRng('memory-transport', this.opts.seed);
  }

  peer(): MemPeer {
    const p = new MemPeer(this, this.peers.length);
    this.peers.push(p);
    this.delivered.set(p, new Set());
    return p;
  }

  /** Peers in different groups cannot exchange values until heal(). Peers not listed form their own group. */
  partition(groups: Transport[][]): void {
    const m = new Map<MemPeer, number>();
    groups.forEach((g, i) => {
      for (const t of g) if (t instanceof MemPeer) m.set(t, i);
    });
    let next = groups.length;
    for (const p of this.peers) if (!m.has(p)) m.set(p, next++);
    this.groupOf = m;
  }

  /** Ends a partition: every stored value reaches every subscriber that has not received it. */
  heal(): void {
    this.groupOf = null;
    for (const [soul, entries] of this.store) {
      for (const [key, e] of entries) {
        for (const sub of this.subs) {
          if (!sub.active || sub.soul !== soul) continue;
          if (this.delivered.get(sub.peer)?.has(soul + '\u0000' + key) === true) continue;
          this.deliver(sub, key, e.value);
        }
        e.groups = new Set();
        e.all = true;
      }
    }
  }

  /** The relay restarts with an empty store (§7.4); peers are notified after 0-5 s. */
  restartEmpty(): void {
    this.epoch++;
    this.store.clear();
    for (const s of this.delivered.values()) s.clear();
    for (const p of this.peers) this.schedule(Math.floor(this.rng() * 5000), () => p.notifyRestart());
  }

  /** Stored values (all souls, or one), sorted. */
  values(soul?: string): string[] {
    const out: string[] = [];
    for (const [s, entries] of this.store) {
      if (soul !== undefined && s !== soul) continue;
      for (const e of entries.values()) out.push(e.value);
    }
    return out.sort();
  }

  souls(): string[] {
    return [...this.store.keys()].sort();
  }

  /** Schedules `fn` at now + delay (virtual ms). */
  schedule(delay: number, fn: () => void): void {
    const ev: QEvent = { time: this.now + Math.max(0, delay), seq: this.seq++, fn };
    // binary-heap insert
    const q = this.queue;
    q.push(ev);
    let i = q.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (less(q[parent], q[i])) break;
      [q[parent], q[i]] = [q[i], q[parent]];
      i = parent;
    }
  }

  private pop(): QEvent | undefined {
    const q = this.queue;
    if (q.length === 0) return undefined;
    const top = q[0];
    const last = q.pop() as QEvent;
    if (q.length > 0) {
      q[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < q.length && less(q[l], q[m])) m = l;
        if (r < q.length && less(q[r], q[m])) m = r;
        if (m === i) break;
        [q[m], q[i]] = [q[i], q[m]];
        i = m;
      }
    }
    return top;
  }

  get pendingEvents(): number {
    return this.queue.length;
  }

  /**
   * Processes events until none is left (or `until()` holds, or `maxEvents`),
   * awaiting `idle()` (every peer's in-flight work) before each event.
   */
  async run(idle: () => Promise<void>, o?: { until?: () => boolean; maxEvents?: number; maxTime?: number }): Promise<void> {
    const max = o?.maxEvents ?? 1_000_000;
    let n = 0;
    for (;;) {
      await idle();
      if (o?.until?.() === true) return;
      const ev = this.pop();
      if (ev === undefined) {
        await idle();
        if (this.queue.length === 0) return;
        continue;
      }
      if (o?.maxTime !== undefined && ev.time > o.maxTime) {
        this.schedule(ev.time - this.now, ev.fn);
        return;
      }
      this.now = Math.max(this.now, ev.time);
      ev.fn();
      this.events++;
      if (++n >= max) throw new Error(`MemoryTransport.run: more than ${max} events`);
    }
  }

  // ------------------------------------------------------------ internals

  private delay(): number {
    const [lo, hi] = this.opts.delayMs;
    if (!this.opts.reorder) return lo;
    return lo + Math.floor(this.rng() * (hi - lo + 1));
  }

  private reachable(from: MemPeer | null, to: MemPeer, e: Entry): boolean {
    if (this.groupOf === null || e.all) return true;
    const g = this.groupOf.get(to) ?? -1;
    if (from !== null && this.groupOf.get(from) === g) return true;
    return e.groups.has(g);
  }

  publishFrom(peer: MemPeer, soul: string, key: Hex32, value: string): Promise<void> {
    return new Promise((resolve) => {
      const attempt = (): void => {
        if (!peer.online) {
          this.schedule(500, attempt);
          return;
        }
        if (this.opts.dropRate > 0 && this.rng() < this.opts.dropRate) {
          this.schedule(100 + Math.floor(this.rng() * 400), attempt);
          return;
        }
        this.schedule(this.delay(), () => {
          this.receive(peer, soul, key, value);
          resolve();
        });
      };
      attempt();
    });
  }

  private receive(peer: MemPeer, soul: string, key: string, value: string): void {
    let entries = this.store.get(soul);
    if (entries === undefined) this.store.set(soul, (entries = new Map()));
    let e = entries.get(key);
    if (e === undefined) {
      e = { value, groups: new Set(), all: this.groupOf === null };
      entries.set(key, e);
    }
    if (this.groupOf !== null) e.groups.add(this.groupOf.get(peer) ?? -1);
    else e.all = true;
    // New value or re-put: deliver to every reachable subscriber (a re-put re-delivers, §7.7).
    for (const sub of this.subs) {
      if (!sub.active || sub.soul !== soul) continue;
      if (!this.reachable(peer, sub.peer, e)) continue;
      this.deliver(sub, key, e.value);
    }
  }

  private deliver(sub: Sub, key: string, value: string): void {
    const epoch = this.epoch;
    const attempt = (): void => {
      if (!sub.active || epoch !== this.epoch) return;
      if (!sub.peer.online) {
        this.schedule(500, attempt);
        return;
      }
      if (this.opts.dropRate > 0 && this.rng() < this.opts.dropRate) {
        this.schedule(100 + Math.floor(this.rng() * 400), attempt);
        return;
      }
      if (sub.peer.dropIncoming !== null && sub.peer.dropIncoming(sub.soul, key, value)) return;
      this.delivered.get(sub.peer)?.add(sub.soul + '\u0000' + key);
      sub.cb(key, value);
    };
    this.schedule(this.delay(), attempt);
    if (this.opts.duplicateRate > 0 && this.rng() < this.opts.duplicateRate) this.schedule(this.delay(), attempt);
  }

  subscribeFrom(peer: MemPeer, soul: string, cb: (key: string, value: string) => void): () => void {
    const sub: Sub = { peer, soul, cb, active: true };
    this.subs.push(sub);
    for (const [key, e] of this.store.get(soul) ?? []) {
      if (this.reachable(null, peer, e)) this.deliver(sub, key, e.value);
    }
    return () => {
      sub.active = false;
      const i = this.subs.indexOf(sub);
      if (i >= 0) this.subs.splice(i, 1);
    };
  }
}

function less(a: QEvent, b: QEvent): boolean {
  return a.time < b.time || (a.time === b.time && a.seq < b.seq);
}
