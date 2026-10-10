/**
 * Small injectable environment for the client runtime (docs/p2p-protocol.md §7):
 * timers and clocks, so that the watchdog, presence and session timers can be
 * driven by a fake clock in node tests.
 */

/** Opaque timer handle (a number in browsers, a Timeout object in node). */
export type TimerHandle = unknown;

export interface Timers {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(h: TimerHandle | null | undefined): void;
  /** Monotonic milliseconds (performance.now in browsers); only drives UI timers (§7.8). */
  now(): number;
}

function perfNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** The real timers of the page (or of node). */
export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => {
    if (h !== null && h !== undefined) clearTimeout(h as Parameters<typeof clearTimeout>[0]);
  },
  now: perfNow,
};

/** A repeating timer on top of `Timers`. Returns a stop function. */
export function every(timers: Timers, ms: number, fn: () => void): () => void {
  let stopped = false;
  let h: TimerHandle | null = null;
  const loop = (): void => {
    if (stopped) return;
    h = timers.setTimeout(() => {
      if (stopped) return;
      try {
        fn();
      } finally {
        loop();
      }
    }, ms);
  };
  loop();
  return () => {
    stopped = true;
    timers.clearTimeout(h);
  };
}

export function sleep(timers: Timers, ms: number): Promise<void> {
  return new Promise((resolve) => {
    timers.setTimeout(resolve, ms);
  });
}

/** Minimal event target (window / document) used for online, pageshow and visibilitychange. */
export interface EventSource {
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
}

export interface VisibilitySource extends EventSource {
  readonly visibilityState: string;
}

/** Simple listener set. */
export class Listeners<T> {
  private readonly set = new Set<(v: T) => void>();

  add(cb: (v: T) => void): () => void {
    this.set.add(cb);
    return () => {
      this.set.delete(cb);
    };
  }

  emit(v: T): void {
    for (const cb of [...this.set]) {
      try {
        cb(v);
      } catch (e) {
        console.error('listener failed', e);
      }
    }
  }

  get size(): number {
    return this.set.size;
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
