/**
 * Single writer (docs/p2p-protocol.md §3.9): only one tab per device runs the
 * protocol driver. `navigator.locks.request('avalon-driver', { ifAvailable:
 * true }, holdUntilUnload)`; a tab that does not get the lock is
 * READ_ONLY_OTHER_TAB and queues for the lock (it takes over when the other tab
 * closes). "Use here" re-requests with `{ steal: true }`, which makes the other
 * tab's request reject (AbortError) and drop to read-only. Only the lock holder
 * signs or publishes.
 */
import { Listeners } from './env.ts';

/** The subset of the Web Locks API used (navigator.locks; faked in node tests). */
export interface LockLike { readonly name: string }
export interface LockRequestOptions { ifAvailable?: boolean; steal?: boolean; mode?: 'exclusive' | 'shared' }
export interface LockManagerLike {
  request(name: string, options: LockRequestOptions, cb: (lock: LockLike | null) => Promise<void> | void): Promise<void>;
}

export interface LockState {
  /** True while this tab holds the driver lock. */
  readonly held: boolean;
  onChange(cb: (held: boolean) => void): () => void;
  /** "Use here": takes the lock from the other tab. Resolves once held. */
  steal(): Promise<void>;
  /** Releases the lock (closing the session). */
  release(): void;
}

export const DRIVER_LOCK = 'avalon-driver';

function defaultLocks(): LockManagerLike | null {
  if (typeof navigator === 'undefined') return null;
  const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks;
  return locks ?? null;
}

function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

class DriverLock implements LockState {
  private heldValue = false;
  private readonly changes = new Listeners<boolean>();
  private releaseHeld: (() => void) | null = null;
  private closed = false;
  private waiting = false;
  /** Generation: a stale grant (after release or a newer request) is let go at once. */
  private gen = 0;

  constructor(private readonly locks: LockManagerLike | null, private readonly name: string) {}

  get held(): boolean {
    return this.heldValue;
  }

  onChange(cb: (held: boolean) => void): () => void {
    return this.changes.add(cb);
  }

  private set(held: boolean): void {
    if (this.heldValue === held) return;
    this.heldValue = held;
    this.changes.emit(held);
  }

  /** Requests the lock; resolves with whether it was granted (ifAvailable) or once granted (queued/steal). */
  request(opts: LockRequestOptions): Promise<boolean> {
    const locks = this.locks;
    if (locks === null) {
      // No Web Locks (old browser, node): this tab is the only writer.
      this.set(!this.closed);
      return Promise.resolve(!this.closed);
    }
    const gen = ++this.gen;
    return new Promise<boolean>((resolve) => {
      let answered = false;
      let mine: (() => void) | null = null;
      const answer = (v: boolean): void => {
        if (!answered) {
          answered = true;
          resolve(v);
        }
      };
      const p = locks.request(this.name, opts, (lock) => {
        if (lock === null || this.closed || gen !== this.gen) {
          answer(false);
          return undefined; // not granted, or stale: released at once
        }
        return new Promise<void>((release) => {
          this.releaseHeld?.();
          this.releaseHeld = release;
          mine = release;
          this.waiting = false;
          this.set(true);
          answer(true);
        });
      });
      p.then(() => answer(false), (e: unknown) => {
        answer(false);
        // Stolen by another tab ("Use here" there): drop to read-only and wait in line again.
        if (mine !== null && this.releaseHeld === mine && isAbort(e)) {
          this.releaseHeld = null;
          this.set(false);
          this.queue();
        }
      });
    });
  }

  /** Waits in line for the lock (it is granted when the holder closes). */
  queue(): void {
    if (this.closed || this.waiting || this.locks === null) return;
    this.waiting = true;
    void this.request({}).then((ok) => {
      if (!ok) this.waiting = false;
    });
  }

  async steal(): Promise<void> {
    if (this.closed) throw new Error('closed');
    if (this.heldValue) return;
    this.waiting = false;
    const ok = await this.request({ steal: true });
    if (!ok) throw new Error('Could not take over from the other tab');
  }

  release(): void {
    this.closed = true;
    this.gen++;
    const r = this.releaseHeld;
    this.releaseHeld = null;
    r?.();
    this.set(false);
  }
}

/**
 * Acquires the driver lock if available. Without it, the returned state is
 * not held and waits in line; `steal()` takes the lock ("Use here").
 */
export async function acquireDriverLock(o: { locks?: LockManagerLike | null; name?: string } = {}): Promise<LockState> {
  const locks = o.locks === undefined ? defaultLocks() : o.locks;
  const lock = new DriverLock(locks, o.name ?? DRIVER_LOCK);
  const ok = await lock.request({ ifAvailable: true });
  if (!ok) lock.queue();
  return lock;
}

// ---------------------------------------------------------------- in-memory Web Locks (tests, and tabs within one process)

interface Holder { id: number; release: () => void; reject: (e: Error) => void }
interface Waiter { id: number; grant: () => void }

/**
 * An in-memory implementation of the Web Locks API semantics used here:
 * exclusive mode, `ifAvailable`, `steal` (the holder's request rejects with
 * AbortError and the lock passes immediately) and FIFO queueing.
 */
export class MemoryLockManager implements LockManagerLike {
  private readonly holders = new Map<string, Holder>();
  private readonly queues = new Map<string, Waiter[]>();
  private nextId = 1;

  holderOf(name: string): number | null {
    return this.holders.get(name)?.id ?? null;
  }

  request(name: string, options: LockRequestOptions, cb: (lock: LockLike | null) => Promise<void> | void): Promise<void> {
    const id = this.nextId++;
    return new Promise<void>((resolve, reject) => {
      const run = (): void => {
        let released = false;
        const holder: Holder = {
          id,
          release: () => {
            if (released) return;
            released = true;
            if (this.holders.get(name)?.id === id) this.holders.delete(name);
            this.grantNext(name);
          },
          reject: (e) => reject(e),
        };
        this.holders.set(name, holder);
        let result: Promise<void> | void;
        try {
          result = cb({ name });
        } catch (e) {
          holder.release();
          reject(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        Promise.resolve(result).then(() => {
          holder.release();
          resolve();
        }, (e: unknown) => {
          holder.release();
          reject(e instanceof Error ? e : new Error(String(e)));
        });
      };
      const current = this.holders.get(name);
      if (options.steal === true) {
        if (current !== undefined) {
          this.holders.delete(name);
          const err = new Error('The lock was stolen');
          err.name = 'AbortError';
          current.reject(err);
        }
        run();
        return;
      }
      if (current === undefined && (this.queues.get(name)?.length ?? 0) === 0) {
        run();
        return;
      }
      if (options.ifAvailable === true) {
        Promise.resolve(cb(null)).then(() => resolve(), (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))));
        return;
      }
      let q = this.queues.get(name);
      if (q === undefined) {
        q = [];
        this.queues.set(name, q);
      }
      q.push({ id, grant: run });
    });
  }

  private grantNext(name: string): void {
    if (this.holders.has(name)) return;
    const q = this.queues.get(name);
    const next = q?.shift();
    if (next !== undefined) next.grant();
  }
}
