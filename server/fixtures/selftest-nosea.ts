// Test fixture (relay.test.ts): the boot self-test against a relay WITHOUT
// SEA: GUN's core plus the node storage and websocket-server modules, i.e.
// what a bundle whose SEA failed to load amounts to. Must exit with status 1.
import '../gun-shim';
import 'gun/lib/yson.js';
import 'gun/lib/store.js';
import 'gun/lib/rfs.js';
import 'gun/lib/wire.js';
import { relaySelfTest } from '../relay';

try {
  await relaySelfTest();
  console.log('SELFTEST PASS');
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
