// Test fixture (relay.test.ts): runs the boot self-test exactly as server.ts
// does, against the full GUN node build (gun + gun/sea). Exit status 1 on
// failure. Mode `nofilter` installs a no-op instead of the relay filter.
import '../gun-shim';
import Gun from 'gun';
import 'gun/sea';
import { relaySelfTest, type GunFactory } from '../relay';

const mode = process.argv[2] ?? 'ok';
try {
  await relaySelfTest({
    Gun: Gun as unknown as GunFactory,
    ...(mode === 'nofilter' ? { installFilter: () => undefined } : {}),
  });
  console.log('SELFTEST PASS');
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
