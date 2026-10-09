/**
 * Test helpers for the client runtime (not bundled): a fake clock and fake
 * window/document event sources.
 */
import type { TimerHandle, Timers, VisibilitySource } from './env.ts';

interface Pending { id: number; at: number; fn: () => void }

/** Deterministic timers: nothing runs until `advance()`. */
export class FakeTimers implements Timers {
  private t = 0;
  private nextId = 1;
  private pending: Pending[] = [];

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.pending.push({ id, at: this.t + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(h: TimerHandle | null | undefined): void {
    this.pending = this.pending.filter((p) => p.id !== h);
  }

  get size(): number {
    return this.pending.length;
  }

  /** Advances the clock, running due timers in order (and the microtasks they queue). */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      this.pending.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.pending[0];
      if (next === undefined || next.at > end) break;
      this.pending.shift();
      this.t = next.at;
      next.fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    this.t = end;
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }
}

/** A window/document stand-in with dispatchable events and a settable visibility. */
export class FakeEvents implements VisibilitySource {
  visibilityState = 'visible';
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, cb: () => void): void {
    let s = this.listeners.get(type);
    if (s === undefined) {
      s = new Set();
      this.listeners.set(type, s);
    }
    s.add(cb);
  }

  removeEventListener(type: string, cb: () => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  dispatch(type: string): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb();
  }

  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}
