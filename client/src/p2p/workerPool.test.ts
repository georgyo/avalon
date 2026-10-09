/** WorkerPool (docs/p2p-protocol.md §7.5) with in-process fake workers running the real worker protocol. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ProveTask, VerifyJob } from '@avalon/common/protocol';
import { defaultPoolSize, WorkerPool, type WorkerLike } from './workerPool.ts';
import { handleWorkerRequest, isWorkerRequest, type WorkerRequest } from './workerProtocol.ts';

class FakeWorker implements WorkerLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  received: WorkerRequest[] = [];
  terminated = false;
  crashNext = false;
  postMessage(msg: WorkerRequest): void {
    // structured clone, like a real worker boundary
    const req: unknown = structuredClone(msg);
    assert.ok(isWorkerRequest(req));
    this.received.push(req);
    setTimeout(() => {
      if (this.crashNext) {
        this.onerror?.(new Error('boom'));
        return;
      }
      this.onmessage?.({ data: structuredClone(handleWorkerRequest(req)) });
    }, 1);
  }
  terminate(): void {
    this.terminated = true;
  }
}

/** Reveal jobs are cheap and self-contained: a mismatching x is rejected. */
function revealJob(i: number): VerifyJob {
  const G = '4gJ7oWhEPdF7VvYH_3YQcGcbJ_EebKmmzk7Kt8wWg24'; // not checked against x: verdict false
  return { id: i.toString(16).padStart(64, '0'), kind: 'reveal', x: 'A'.repeat(43), y: G, Y: G, ballots: [] };
}

describe('WorkerPool', () => {
  it('pool size is max(1, min(4, hardwareConcurrency - 1))', () => {
    const n = defaultPoolSize();
    assert.ok(n >= 1 && n <= 4);
  });

  it('splits a verification batch across workers and keeps the result order', async () => {
    const workers: FakeWorker[] = [];
    const pool = new WorkerPool({ size: 3, create: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    } });
    const jobs = Array.from({ length: 7 }, (_, i) => revealJob(i));
    const vs = await pool.verify(jobs);
    assert.equal(vs.length, 7);
    assert.ok(vs.every((v) => typeof v.ok === 'boolean'));
    assert.equal(workers.length, 3);
    assert.deepEqual(workers.map((w) => w.received.length), [1, 1, 1]);
    const ids = workers.flatMap((w) => w.received.flatMap((r) => (r.op === 'verify' ? r.jobs.map((j) => j.id) : [])));
    assert.deepEqual(ids, jobs.map((j) => j.id));
    // same verdicts as in-process
    const local = handleWorkerRequest({ id: 1, op: 'verify', jobs });
    assert.ok(local.ok);
    assert.deepEqual(vs, local.ok && local.op === 'verify' ? local.result : null);
    pool.terminate();
    assert.ok(workers.every((w) => w.terminated));
  });

  it('a prove error is reported; unknown tasks reject', async () => {
    const pool = new WorkerPool({ size: 1, create: () => new FakeWorker() });
    const task: ProveTask = { kind: 'nonsense' };
    await assert.rejects(pool.prove(task), /unknown task/);
    pool.terminate();
  });

  it('a crashed worker is replaced and its work runs in-process', async () => {
    const workers: FakeWorker[] = [];
    const pool = new WorkerPool({ size: 1, create: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    } });
    await pool.verify([revealJob(1)]);
    workers[0].crashNext = true;
    const vs = await pool.verify([revealJob(2), revealJob(3)]);
    assert.equal(vs.length, 2);
    assert.equal(workers[0].terminated, true);
    await pool.verify([revealJob(4)]);
    assert.equal(workers.length, 2, 'replaced');
    pool.terminate();
  });

  it('without Worker support everything runs in-process', async () => {
    const pool = new WorkerPool({ size: 2, create: () => null });
    const vs = await pool.verify([revealJob(5)]);
    assert.equal(vs.length, 1);
    await assert.rejects(pool.prove({ kind: 'nonsense' }), /unknown task/);
  });
});
