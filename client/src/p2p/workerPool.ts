/**
 * Worker pool (docs/p2p-protocol.md §7.5): a `CryptoBackend` that runs
 * verification jobs and build/prove tasks in `crypto.worker.ts`, pool size
 * `max(1, min(4, hardwareConcurrency − 1))`. A verification batch is split
 * into one chunk per worker (each chunk is batch-verified there). Without
 * Worker support (node), or if a worker dies, the work runs in-process.
 */
import { localCrypto, type CryptoBackend, type ProveTask, type Verdict, type VerifyJob } from '@avalon/common/protocol';
import { isWorkerResponse, type WorkerRequest, type WorkerResponse } from './workerProtocol.ts';

export interface WorkerLike {
  postMessage(msg: WorkerRequest): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  terminate(): void;
}

export interface WorkerPoolOptions {
  size?: number;
  /** Creates a worker (default: the module worker crypto.worker.ts). Return null when unsupported. */
  create?: () => WorkerLike | null;
  /** Used when no worker can be created (default: in-process runJobs/runProve). */
  fallback?: CryptoBackend;
}

export function defaultPoolSize(): number {
  const hc = typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : 2;
  return Math.max(1, Math.min(4, hc - 1));
}

/** The module worker. Vite bundles it from this exact expression. */
export function createCryptoWorker(): WorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  const w = new Worker(new URL('./crypto.worker.ts', import.meta.url), { type: 'module' });
  return w as unknown as WorkerLike;
}

interface Pending { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }

interface Slot {
  worker: WorkerLike;
  load: number;
  pending: Map<number, Pending>;
}

export class WorkerPool implements CryptoBackend {
  readonly size: number;
  private readonly create: () => WorkerLike | null;
  private readonly fallback: CryptoBackend;
  private slots: (Slot | null)[] = [];
  private nextId = 1;
  private disabled = false;
  /** Jobs and tasks run so far (diagnostics, §9 checks). */
  readonly log: { op: 'verify' | 'prove'; size: number }[] = [];

  constructor(o: WorkerPoolOptions = {}) {
    this.size = Math.max(1, o.size ?? defaultPoolSize());
    this.create = o.create ?? createCryptoWorker;
    this.fallback = o.fallback ?? localCrypto();
  }

  private slot(i: number): Slot | null {
    if (this.disabled) return null;
    const existing = this.slots[i];
    if (existing !== null && existing !== undefined) return existing;
    let worker: WorkerLike | null;
    try {
      worker = this.create();
    } catch {
      worker = null;
    }
    if (worker === null) {
      this.disabled = true;
      return null;
    }
    const s: Slot = { worker, load: 0, pending: new Map() };
    worker.onmessage = (ev) => {
      const r = ev.data;
      if (!isWorkerResponse(r)) return;
      const p = s.pending.get(r.id);
      if (p === undefined) return;
      s.pending.delete(r.id);
      p.resolve(r);
    };
    worker.onerror = () => this.kill(i, s, new Error('crypto worker failed'));
    this.slots[i] = s;
    return s;
  }

  private kill(i: number, s: Slot, e: Error): void {
    if (this.slots[i] === s) this.slots[i] = null;
    try {
      s.worker.terminate();
    } catch {
      // gone
    }
    const pend = [...s.pending.values()];
    s.pending.clear();
    for (const p of pend) p.reject(e);
  }

  private leastLoaded(): { i: number; s: Slot } | null {
    let best: { i: number; s: Slot } | null = null;
    for (let i = 0; i < this.size; i++) {
      const s = this.slot(i);
      if (s === null) return null;
      if (best === null || s.load < best.s.load) best = { i, s };
    }
    return best;
  }

  private run(i: number, s: Slot, req: WorkerRequest): Promise<WorkerResponse> {
    s.load++;
    return new Promise<WorkerResponse>((resolve, reject) => {
      s.pending.set(req.id, { resolve, reject });
      try {
        s.worker.postMessage(req);
      } catch (e) {
        s.pending.delete(req.id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    }).finally(() => {
      s.load--;
    });
  }

  async verify(jobs: VerifyJob[]): Promise<Verdict[]> {
    if (jobs.length === 0) return [];
    this.log.push({ op: 'verify', size: jobs.length });
    const first = this.leastLoaded();
    if (first === null) return this.fallback.verify(jobs);
    const chunks = Math.min(this.size, jobs.length);
    const per = Math.ceil(jobs.length / chunks);
    const parts: VerifyJob[][] = [];
    for (let k = 0; k < jobs.length; k += per) parts.push(jobs.slice(k, k + per));
    const results = await Promise.all(parts.map(async (part) => {
      const target = this.leastLoaded();
      if (target === null) return this.fallback.verify(part);
      try {
        const r = await this.run(target.i, target.s, { id: this.nextId++, op: 'verify', jobs: part });
        if (r.ok && r.op === 'verify') return r.result;
        throw new Error(r.ok ? 'unexpected reply' : r.error);
      } catch {
        // worker died: verify in-process so the game proceeds
        return this.fallback.verify(part);
      }
    }));
    return results.flat();
  }

  async prove(task: ProveTask): Promise<unknown> {
    this.log.push({ op: 'prove', size: 1 });
    const target = this.leastLoaded();
    if (target === null) return this.fallback.prove(task);
    let r: WorkerResponse;
    try {
      r = await this.run(target.i, target.s, { id: this.nextId++, op: 'prove', task });
    } catch {
      return this.fallback.prove(task);
    }
    if (!r.ok) throw new Error(r.error);
    return r.result;
  }

  terminate(): void {
    this.slots.forEach((s, i) => {
      if (s !== null && s !== undefined) this.kill(i, s, new Error('pool terminated'));
    });
    this.slots = [];
  }
}
