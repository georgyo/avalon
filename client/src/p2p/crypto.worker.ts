/**
 * The crypto worker (docs/p2p-protocol.md §7.5): all proving and verification
 * run here, off the UI thread. Loaded by WorkerPool with
 * `new Worker(new URL('./crypto.worker.ts', import.meta.url), { type: 'module' })`.
 */
import { warmUpTables } from '@avalon/common/crypto';
import { handleWorkerRequest, isWorkerRequest, type WorkerResponse } from './workerProtocol.ts';

const scope = self as unknown as AvalonWorkerScope;

// Build the fixed-base tables right away (WorkerPool starts its workers when the session opens), so the
// first proof or verification of a game does not pay for them (§7.5). A request that arrives meanwhile
// waits until this returns.
warmUpTables();

scope.onmessage = (ev: MessageEvent<unknown>) => {
  const req = ev.data;
  if (!isWorkerRequest(req)) {
    const id = typeof req === 'object' && req !== null && typeof (req as { id?: unknown }).id === 'number' ? (req as { id: number }).id : -1;
    const reply: WorkerResponse = { id, ok: false, error: 'malformed request' };
    scope.postMessage(reply);
    return;
  }
  scope.postMessage(handleWorkerRequest(req));
};
