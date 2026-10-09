// Must be the first import of every entry point that loads `gun/sea` (§8 of
// docs/p2p-protocol.md).
//
// In the esbuild bundle SEA's dynamic `USE(x, 1)` requires
// (`./lib/text-encoding`, `@peculiar/webcrypto`) cannot be resolved, and a
// relay without a working SEA accepts forged user-space and non-hash `#`
// writes. When `self` is defined before SEA is first evaluated, SEA takes
// `crypto` (Node's built-in WebCrypto) and `TextEncoder`/`TextDecoder` from it
// and never reaches those requires; `GUN` lets SEA find the same `Gun` object.
//
// This imports the core `gun/gun.js` rather than `gun` (lib/server.js): the
// latter already requires `../sea` while it is being evaluated, i.e. before
// this module's body could define `self`. `gun/gun.js` is the very object that
// lib/server.js exports, so the globals below are the `Gun` that every later
// `import Gun from 'gun'` returns.
import Gun from 'gun/gun.js';

const g = globalThis as typeof globalThis & { self?: unknown; GUN?: unknown };
g.self ??= globalThis;
g.GUN = Gun;
(g as { Gun?: unknown }).Gun = Gun;

export default Gun;
