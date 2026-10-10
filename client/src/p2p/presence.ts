/**
 * Presence and device liveness (docs/p2p-protocol.md §7.6).
 *
 * * Every 10 s and on visibility changes, writes to the own user space
 *   `avalon_v1_presence` = `canon({lobby, game, seq, vis, head})` (`seq`
 *   increments, `vis` 1 if the page is visible, `head` = first 8 hex of the
 *   local head digest). Nothing role-dependent (§9).
 * * A member is online if a new `seq` arrived within the last 30 s of local
 *   receipt time; sender timestamps are never compared.
 * * While a game is non-terminal the client holds a screen Wake Lock,
 *   re-acquired when the page becomes visible.
 */
import { canon, parseCanon } from '@avalon/common/crypto';
import { Listeners, realTimers, type TimerHandle, type Timers, type VisibilitySource } from './env.ts';

export const PRESENCE_KEY = 'avalon_v1_presence';
export const PRESENCE_INTERVAL_MS = 10000;
export const ONLINE_WINDOW_MS = 30000;

export interface PresenceValue { lobby: string; game: string; seq: number; vis: 0 | 1; head: string }

export interface PresenceInfo {
  online: boolean;
  /** Local receipt time (Timers.now) of the last new heartbeat, or null. */
  lastSeen: number | null;
  value: PresenceValue | null;
}

export interface PresenceTransport {
  putUser(key: string, value: string): Promise<void>;
  watchUser(pub: string, key: string, cb: (value: string) => void): () => void;
}

export interface WakeLockSentinelLike { release(): Promise<void>; readonly released?: boolean }
export interface WakeLockLike { request(type: 'screen'): Promise<WakeLockSentinelLike> }

export interface PresenceOptions {
  transport: PresenceTransport;
  timers?: Timers;
  document?: VisibilitySource | null;
  wakeLock?: WakeLockLike | null;
  /** Initial seq (monotone across reloads: the drift-corrected clock). */
  seqStart?: number;
}

export function parsePresence(s: string): PresenceValue | null {
  let v: unknown;
  try {
    v = parseCanon(s);
  } catch {
    try {
      v = JSON.parse(s);
    } catch {
      return null;
    }
  }
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.lobby !== 'string' || typeof r.game !== 'string' || typeof r.head !== 'string') return null;
  if (typeof r.seq !== 'number' || !Number.isSafeInteger(r.seq)) return null;
  if (r.vis !== 0 && r.vis !== 1) return null;
  return { lobby: r.lobby, game: r.game, seq: r.seq, vis: r.vis, head: r.head };
}

function defaultWakeLock(): WakeLockLike | null {
  if (typeof navigator === 'undefined') return null;
  const wl = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
  return wl ?? null;
}

export class Presence {
  private readonly o: PresenceOptions;
  private readonly timers: Timers;
  private readonly doc: VisibilitySource | null;
  private readonly wakeLock: WakeLockLike | null;
  private state: { lobby: string; game: string; head: string } = { lobby: '', game: '', head: '' };
  private seq: number;
  private timer: TimerHandle | null = null;
  private running = false;
  private writing = false;
  private readonly watched = new Map<string, { unsub: () => void; info: PresenceInfo }>();
  private readonly changes = new Listeners<string>();
  private visHandler: (() => void) | null = null;
  private wantWake = false;
  private sentinel: WakeLockSentinelLike | null = null;
  private wakeBusy = false;

  constructor(o: PresenceOptions) {
    this.o = o;
    this.timers = o.timers ?? realTimers;
    this.doc = o.document === undefined ? (typeof document !== 'undefined' ? document : null) : o.document;
    this.wakeLock = o.wakeLock === undefined ? defaultWakeLock() : o.wakeLock;
    this.seq = Math.max(1, Math.floor(o.seqStart ?? 1));
  }

  private visible(): boolean {
    return this.doc === null || this.doc.visibilityState === 'visible';
  }

  /** Starts the heartbeat (after the identity exists and the GUN user is authenticated by putUser). */
  start(): void {
    if (this.running) return;
    this.running = true;
    const d = this.doc;
    if (d !== null) {
      this.visHandler = () => {
        void this.beat();
        if (this.visible()) void this.syncWakeLock();
      };
      d.addEventListener('visibilitychange', this.visHandler);
    }
    void this.beat();
    this.schedule();
  }

  stop(): void {
    this.running = false;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
    if (this.doc !== null && this.visHandler !== null) this.doc.removeEventListener('visibilitychange', this.visHandler);
    this.visHandler = null;
    for (const w of this.watched.values()) w.unsub();
    this.watched.clear();
    this.setWakeLock(false);
  }

  /** What the heartbeat carries (lobbyId, gameId, head digest). */
  setState(s: { lobby?: string | null; game?: string | null; head?: string | null }): void {
    const next = {
      lobby: s.lobby ?? '',
      game: s.game ?? '',
      head: (s.head ?? '').slice(0, 8),
    };
    const changed = next.lobby !== this.state.lobby || next.game !== this.state.game;
    this.state = next;
    if (changed && this.running) void this.beat();
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = this.timers.setTimeout(() => {
      void this.beat();
      this.schedule();
    }, PRESENCE_INTERVAL_MS);
  }

  /** Writes one heartbeat now. */
  async beat(): Promise<void> {
    if (!this.running || this.writing) return;
    this.writing = true;
    try {
      const v: PresenceValue = { ...this.state, seq: this.seq++, vis: this.visible() ? 1 : 0 };
      await this.o.transport.putUser(PRESENCE_KEY, canon(v));
    } catch {
      // not authenticated yet / offline: the next beat retries
    } finally {
      this.writing = false;
    }
  }

  /** Sets the watched members (roster order, §7.3); others are dropped. */
  watch(pubs: readonly string[]): void {
    const want = new Set(pubs);
    for (const [pub, w] of this.watched) {
      if (!want.has(pub)) {
        w.unsub();
        this.watched.delete(pub);
      }
    }
    for (const pub of pubs) {
      if (this.watched.has(pub)) continue;
      const entry: { unsub: () => void; info: PresenceInfo } = { unsub: () => undefined, info: { online: false, lastSeen: null, value: null } };
      this.watched.set(pub, entry);
      entry.unsub = this.o.transport.watchUser(pub, PRESENCE_KEY, (raw) => {
        const v = parsePresence(raw);
        if (v === null) return;
        const prev = entry.info.value;
        if (prev !== null && prev.seq === v.seq) return;
        entry.info = { online: true, lastSeen: this.timers.now(), value: v };
        this.changes.emit(pub);
      });
    }
  }

  info(pub: string): PresenceInfo {
    const w = this.watched.get(pub);
    if (w === undefined) return { online: false, lastSeen: null, value: null };
    const i = w.info;
    return { ...i, online: i.lastSeen !== null && this.timers.now() - i.lastSeen <= ONLINE_WINDOW_MS };
  }

  isOnline(pub: string): boolean {
    return this.info(pub).online;
  }

  onChange(cb: (pub: string) => void): () => void {
    return this.changes.add(cb);
  }

  /** Holds a screen wake lock while `wanted` (a non-terminal game). */
  setWakeLock(wanted: boolean): void {
    this.wantWake = wanted;
    void this.syncWakeLock();
  }

  get wakeLockHeld(): boolean {
    return this.sentinel !== null && this.sentinel.released !== true;
  }

  private async syncWakeLock(): Promise<void> {
    if (this.wakeBusy || this.wakeLock === null) return;
    this.wakeBusy = true;
    try {
      const held = this.sentinel !== null && this.sentinel.released !== true;
      if (this.wantWake && !held && this.visible()) {
        this.sentinel = await this.wakeLock.request('screen');
      } else if (!this.wantWake && this.sentinel !== null) {
        const s = this.sentinel;
        this.sentinel = null;
        await s.release();
      }
    } catch {
      // not allowed (hidden page, no user activation): retried on the next visibility change
    } finally {
      this.wakeBusy = false;
    }
  }
}
