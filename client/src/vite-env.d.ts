/// <reference types="vite/client" />

// Worker typing (docs/p2p-protocol.md §7.5, §11.1). client/src/p2p/crypto.worker.ts is loaded with
// `new Worker(new URL('./crypto.worker.ts', import.meta.url), { type: 'module' })` and bundled by Vite as
// an ES module worker (vite.config.js `worker.format = 'es'`). The client compiles with
// lib ["ES2022", "DOM", "WebWorker"], where the global `self` is typed as `Window`; the worker narrows it:
//
//   const scope = self as unknown as AvalonWorkerScope;
//   scope.onmessage = (ev: MessageEvent<WorkerRequest>) => { ... scope.postMessage(reply) };
type AvalonWorkerScope = DedicatedWorkerGlobalScope;
