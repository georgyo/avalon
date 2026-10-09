/**
 * Transport watchdog and republish (docs/p2p-protocol.md §7.2, §7.4).
 *
 * GUN's websocket adapter retries once after about 2 s and then never again,
 * and puts made while disconnected are never pushed on reconnect. The watchdog:
 *
 * * tracks `hi`/`bye`; when no wire has been open for 2 s it reconnects with
 *   backoff 1, 2, 4, 8, then every 15 s, forever; `online`, `pageshow` and
 *   `visibilitychange` (to visible) reconnect at once;
 * * on every `hi` (and at start) calls `onHi` (the owner re-puts the journal of
 *   the active lobby and game and re-asks the souls) and fetches
 *   `/api/relay-info`;
 * * syncs the clock at start and every 10 minutes (§7.2);
 * * when the relay's `bootId` changes (restarted, possibly with an empty
 *   disk), calls `onNewBoot` after a random 0-5 s delay (the owner re-puts the
 *   entire verified transcript).
 */
import { realTimers, type EventSource, type TimerHandle, type Timers, type VisibilitySource } from './env.ts';
import type { RelayInfo } from './gun.ts';

export interface WatchdogTarget {
  connected(): boolean;
  onHi(cb: () => void): () => void;
  onBye(cb: () => void): () => void;
  reconnect(): void;
}

export interface WatchdogOptions {
  target: WatchdogTarget;
  /** GET /api/relay-info (with the round-trip time). */
  relayInfo: () => Promise<RelayInfo & { rtt: number }>;
  /** Clock synchronisation (§7.2). */
  onClock?: (info: RelayInfo & { rtt: number }) => void;
  /** Re-put the journal of the active lobby and game, then re-ask the souls. */
  onHi: () => void;
  /** The relay restarted: re-put the entire verified transcript. */
  onNewBoot: () => void;
  /** Connection state changes (UI). */
  onConnectedChange?: (connected: boolean) => void;
  timers?: Timers;
  random?: () => number;
  window?: EventSource | null;
  document?: VisibilitySource | null;
}

/** §7.4 / Appendix B: reconnect backoff 1, 2, 4, 8, then 15 s. */
export const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000];
export const RECONNECT_STEADY_MS = 15000;
/** No open wire for this long triggers a reconnect. */
export const DOWN_GRACE_MS = 2000;
/** Clock resync. */
export const CLOCK_RESYNC_MS = 10 * 60 * 1000;
/** Random delay before a full republish after a relay restart. */
export const NEW_BOOT_MAX_DELAY_MS = 5000;
const CHECK_MS = 500;

export class Watchdog {
  private readonly o: WatchdogOptions;
  private readonly timers: Timers;
  private readonly random: () => number;
  private started = false;
  private stopped = false;
  private wasConnected = false;
  private downSinceValue: number | null = null;
  private attempt = 0;
  private nextAttemptAt = 0;
  private checkTimer: TimerHandle | null = null;
  private clockTimer: TimerHandle | null = null;
  private bootTimer: TimerHandle | null = null;
  private bootId: string | null = null;
  private infoInFlight: Promise<void> | null = null;
  private readonly unsubs: (() => void)[] = [];
  /** Number of reconnect attempts made (tests, diagnostics). */
  reconnects = 0;

  constructor(o: WatchdogOptions) {
    this.o = o;
    this.timers = o.timers ?? realTimers;
    this.random = o.random ?? Math.random;
  }

  get lastBootId(): string | null {
    return this.bootId;
  }

  /** Local time since which no wire has been open, or null when connected. */
  get downSince(): number | null {
    return this.downSinceValue;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const t = this.o.target;
    this.unsubs.push(t.onHi(() => this.handleHi()));
    this.unsubs.push(t.onBye(() => this.check()));
    const w = this.o.window;
    if (w) {
      const poke = (): void => this.poke();
      w.addEventListener('online', poke);
      w.addEventListener('pageshow', poke);
      this.unsubs.push(() => {
        w.removeEventListener('online', poke);
        w.removeEventListener('pageshow', poke);
      });
    }
    const d = this.o.document;
    if (d) {
      const vis = (): void => {
        if (d.visibilityState === 'visible') this.poke();
      };
      d.addEventListener('visibilitychange', vis);
      this.unsubs.push(() => d.removeEventListener('visibilitychange', vis));
    }
    this.wasConnected = t.connected();
    if (!this.wasConnected) this.downSinceValue = this.timers.now();
    this.o.onHi();
    void this.fetchInfo();
    this.scheduleCheck();
    this.scheduleClock();
  }

  stop(): void {
    this.stopped = true;
    for (const u of this.unsubs.splice(0)) u();
    this.timers.clearTimeout(this.checkTimer);
    this.timers.clearTimeout(this.clockTimer);
    this.timers.clearTimeout(this.bootTimer);
  }

  /** Reconnect now if no wire is open (online, pageshow, visible). */
  poke(): void {
    if (this.stopped) return;
    if (!this.o.target.connected()) {
      this.attempt = 0;
      this.nextAttemptAt = this.timers.now();
      this.doReconnect();
    }
    this.check();
  }

  /** Fetches relay-info now: clock and bootId check. */
  refresh(): Promise<void> {
    return this.fetchInfo();
  }

  private handleHi(): void {
    if (this.stopped) return;
    this.attempt = 0;
    this.check();
    this.o.onHi();
    void this.fetchInfo();
  }

  private check(): void {
    if (this.stopped) return;
    const now = this.timers.now();
    const up = this.o.target.connected();
    if (up !== this.wasConnected) {
      this.wasConnected = up;
      this.o.onConnectedChange?.(up);
    }
    if (up) {
      this.downSinceValue = null;
      this.attempt = 0;
      return;
    }
    if (this.downSinceValue === null) {
      this.downSinceValue = now;
      this.nextAttemptAt = now + DOWN_GRACE_MS;
      return;
    }
    if (now - this.downSinceValue >= DOWN_GRACE_MS && now >= this.nextAttemptAt) this.doReconnect();
  }

  private doReconnect(): void {
    const now = this.timers.now();
    const wait = this.attempt < RECONNECT_BACKOFF_MS.length ? RECONNECT_BACKOFF_MS[this.attempt] : RECONNECT_STEADY_MS;
    this.attempt++;
    this.nextAttemptAt = now + wait;
    this.reconnects++;
    try {
      this.o.target.reconnect();
    } catch (e) {
      console.warn('reconnect failed', e);
    }
  }

  private scheduleCheck(): void {
    if (this.stopped) return;
    this.checkTimer = this.timers.setTimeout(() => {
      this.check();
      this.scheduleCheck();
    }, CHECK_MS);
  }

  private scheduleClock(): void {
    if (this.stopped) return;
    this.clockTimer = this.timers.setTimeout(() => {
      void this.fetchInfo();
      this.scheduleClock();
    }, CLOCK_RESYNC_MS);
  }

  private fetchInfo(): Promise<void> {
    if (this.infoInFlight !== null) return this.infoInFlight;
    const p = (async () => {
      try {
        const info = await this.o.relayInfo();
        if (this.stopped) return;
        this.o.onClock?.(info);
        const prev = this.bootId;
        this.bootId = info.bootId;
        if (prev !== null && prev !== info.bootId) {
          this.timers.clearTimeout(this.bootTimer);
          this.bootTimer = this.timers.setTimeout(() => {
            this.bootTimer = null;
            if (!this.stopped) this.o.onNewBoot();
          }, Math.floor(this.random() * NEW_BOOT_MAX_DELAY_MS));
        }
      } catch {
        // offline or relay down: retried on the next hi or clock tick
      } finally {
        this.infoInFlight = null;
      }
    })();
    this.infoInFlight = p;
    return p;
  }
}
