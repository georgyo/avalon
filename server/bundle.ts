// Bundles the relay (server.ts, gun, gun/sea, express) into one ESM file.
//
//   yarn bundle:server                     -> dist-server/server.js
//   tsx server/bundle.ts --outfile <path>  -> <path>
//
// The file runs from anywhere (no node_modules needed); it serves `dist/`
// next to itself. gun-shim.ts makes SEA work in the bundle (§8).

import { build, type BuildOptions } from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Recreates `require`, `__filename` and `__dirname` for the CommonJS code inside the ESM bundle. */
const BANNER = [
  "import{createRequire}from'module';",
  "import{fileURLToPath as _f}from'url';",
  "import{dirname as _d}from'path';",
  'const require=createRequire(import.meta.url);',
  'const __filename=_f(import.meta.url);',
  'const __dirname=_d(__filename);',
].join('');

export const DEFAULT_OUTFILE = path.join(here, '..', 'dist-server', 'server.js');

export function bundleOptions(outfile: string = DEFAULT_OUTFILE): BuildOptions {
  return {
    entryPoints: [path.join(here, 'server.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    banner: { js: BANNER },
    logLevel: 'warning',
    // Optional native accelerators of `ws`, required inside try/catch.
    external: ['bufferutil', 'utf-8-validate'],
  };
}

export async function bundleServer(outfile: string = DEFAULT_OUTFILE): Promise<void> {
  await build(bundleOptions(outfile));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--outfile');
  const outfile = i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : DEFAULT_OUTFILE;
  await bundleServer(outfile);
  console.log(`Bundled relay -> ${path.relative(process.cwd(), outfile) || outfile}`);
}
