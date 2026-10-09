/**
 * Messages between WorkerPool and crypto.worker.ts (docs/p2p-protocol.md
 * §7.5): pure jobs over encoded inputs, run by `runJobs` / `runProve`
 * (common/protocol/jobs.ts). Everything is structured-cloneable.
 */
import { runJobs, runProve, type ProveTask, type Verdict, type VerifyJob } from '@avalon/common/protocol';

export type WorkerRequest =
  | { id: number; op: 'verify'; jobs: VerifyJob[] }
  | { id: number; op: 'prove'; task: ProveTask };

export type WorkerResponse =
  | { id: number; ok: true; op: 'verify'; result: Verdict[] }
  | { id: number; ok: true; op: 'prove'; result: unknown }
  | { id: number; ok: false; error: string };

export function isWorkerRequest(v: unknown): v is WorkerRequest {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== 'number') return false;
  if (r.op === 'verify') return Array.isArray(r.jobs);
  if (r.op === 'prove') return typeof r.task === 'object' && r.task !== null && typeof (r.task as Record<string, unknown>).kind === 'string';
  return false;
}

export function isWorkerResponse(v: unknown): v is WorkerResponse {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === 'number' && typeof r.ok === 'boolean';
}

/** Runs one request (in the worker, or in-process as a fallback). Never throws. */
export function handleWorkerRequest(req: WorkerRequest): WorkerResponse {
  try {
    if (req.op === 'verify') return { id: req.id, ok: true, op: 'verify', result: runJobs(req.jobs) };
    return { id: req.id, ok: true, op: 'prove', result: runProve(req.task) };
  } catch (e) {
    return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
