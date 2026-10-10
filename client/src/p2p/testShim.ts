/**
 * Node test setup (not bundled): must be imported before anything that loads
 * `gun/sea`. SEA picks Node's built-in WebCrypto and TextEncoder from `self`
 * (the same trick as server/gun-shim.ts), and finds `Gun` through `GUN`.
 */
import Gun from 'gun/gun.js';

const g = globalThis as unknown as Record<string, unknown>;
if (g.self === undefined) g.self = globalThis;
g.GUN = Gun;
g.Gun = Gun;

export default Gun;
