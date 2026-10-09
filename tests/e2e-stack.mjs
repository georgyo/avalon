// Brings up a throwaway local Avalon stack and runs the e2e suite against it.
//
//   relay :8001 (GUN relay + /api/relay-info, temporary GUN_DIR)
//        ^            ^
//        | /gun (ws)  | /api
//        |            |
//   vite dev :5173 <---- Playwright
//
// There is no backend state besides the relay's temporary radisk directory
// (deleted on exit) and no emulator: the game runs peer-to-peer between the
// browser pages; the relay only stores and forwards signed messages.
//
// Usage:  node tests/e2e-stack.mjs [test-file ...]
// Defaults to running every tests/e2e-*.mjs file except this one.
//
// PLAYERS=5..10 (or a list such as PLAYERS=5,7,10) runs e2e-full-game.mjs once
// per player count, passing PLAYERS=<n> to each run. A single number is passed
// through unchanged.

import { spawn } from 'child_process';
import { createConnection } from 'net';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');

const RELAY_PORT = 8001;
const VITE_PORT = 5173;
const RELAY_URL = `http://127.0.0.1:${RELAY_PORT}`;

const gunDir = mkdtempSync(join(tmpdir(), 'avalon-e2e-gun-'));

const children = [];
let shuttingDown = false;

function run(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: opts.cwd || repoRoot,
    env: { ...process.env, ...(opts.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group: `yarn` runs the relay and vite as grandchildren, which a plain kill of the
    // yarn process would leave running (holding :8001 / :5173 for the next run).
    detached: true,
  });
  children.push({ name, child });

  const prefix = (line) => `  [${name}] ${line}`;
  for (const stream of [child.stdout, child.stderr]) {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) if (l.trim()) console.log(prefix(l.trimEnd()));
    });
  }

  child.on('exit', (code, signal) => {
    if (!shuttingDown && code !== 0) {
      console.error(`\nFAIL: ${name} exited early (code=${code} signal=${signal})`);
      shutdown(1);
    }
  });

  return child;
}

function connects(host, port) {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
    setTimeout(() => done(false), 1000);
  });
}

// Vite binds "localhost", which on a dual-stack host resolves to ::1, while the
// relay binds 127.0.0.1. Probe both families and remember which one answered
// so later HTTP requests use a reachable address.
const reachableHost = {};
async function portOpen(port) {
  for (const host of ['127.0.0.1', '::1']) {
    if (await connects(host, port)) {
      reachableHost[port] = host === '::1' ? '[::1]' : host;
      return true;
    }
  }
  return false;
}

async function waitForPort(port, label, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  process.stdout.write(`==> waiting for ${label} on :${port} `);
  while (Date.now() < deadline) {
    if (await portOpen(port)) {
      console.log('ready');
      return;
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('');
  throw new Error(`${label} did not come up on port ${port} within ${timeoutMs}ms`);
}

// The relay only listens after its boot self-test passed; confirm it answers.
async function checkRelay() {
  const res = await fetch(`${RELAY_URL}/api/relay-info`);
  const info = res.ok ? await res.json() : null;
  if (!info || typeof info.bootId !== 'string') throw new Error('relay did not answer /api/relay-info');
}

// Fetch the app shell and its entry module until both come back cleanly, so the
// first Playwright navigation isn't the thing that triggers a dep re-bundle.
async function warmUp(timeoutMs = 60000) {
  const base = `http://${reachableHost[VITE_PORT] || '127.0.0.1'}:${VITE_PORT}`;
  const deadline = Date.now() + timeoutMs;
  process.stdout.write('==> warming up vite ');
  while (Date.now() < deadline) {
    try {
      const html = await fetch(`${base}/`).then((r) => (r.ok ? r.text() : null));
      const entry = html && html.match(/src="(\/src\/[^"]+)"/)?.[1];
      if (entry) {
        const res = await fetch(base + entry);
        if (res.ok && (res.headers.get('content-type') || '').includes('javascript')) {
          console.log('ready');
          return;
        }
      }
    } catch {
      // server not answering yet
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('');
  throw new Error('vite dev server never served a usable entry module');
}

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // already gone
  }
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n==> shutting down local stack');
  for (const { name, child } of children.reverse()) {
    if (child.exitCode === null) {
      console.log(`  stopping ${name}`);
      killGroup(child, 'SIGTERM');
    }
  }
  // Give them a moment to exit cleanly, then force.
  await new Promise((r) => setTimeout(r, 2000));
  for (const { child } of children) killGroup(child, 'SIGKILL');
  rmSync(gunDir, { recursive: true, force: true });
  process.exit(code);
}

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));

// "5..10" -> [5..10]; "5,7,10" -> [5, 7, 10]; anything else -> null (passed through).
function playerCounts(spec) {
  if (!spec) return null;
  const range = /^(\d+)\.\.(\d+)$/.exec(spec);
  if (range) {
    const [lo, hi] = [Number(range[1]), Number(range[2])];
    return Array.from({ length: Math.max(0, hi - lo + 1) }, (_, i) => lo + i);
  }
  if (/^\d+(,\d+)+$/.test(spec)) return spec.split(',').map(Number);
  return null;
}

function expandRuns(testFiles) {
  const counts = playerCounts(process.env.PLAYERS);
  const runs = [];
  for (const file of testFiles) {
    if (counts && basename(file) === 'e2e-full-game.mjs') {
      for (const n of counts) runs.push({ file, label: `${basename(file)} PLAYERS=${n}`, env: { PLAYERS: String(n) } });
    } else {
      runs.push({ file, label: basename(file), env: {} });
    }
  }
  return runs;
}

async function main() {
  const requested = process.argv.slice(2);
  const testFiles = requested.length
    ? requested
    : readdirSync(__dirname)
        .filter((f) => f.startsWith('e2e-') && f.endsWith('.mjs') && f !== basename(__filename))
        .sort()
        .map((f) => join(__dirname, f));
  const runs = expandRuns(testFiles);

  console.log('==> tests to run:');
  for (const r of runs) console.log(`      ${r.label}`);

  // A leftover relay or vite from an earlier run would answer the readiness probes below.
  for (const [port, label] of [[RELAY_PORT, 'relay'], [VITE_PORT, 'vite']]) {
    if (await portOpen(port)) throw new Error(`port ${port} (${label}) is already in use; stop the process listening there`);
  }

  // 1. The relay, on a throwaway radisk directory. It only listens once its
  //    boot self-test (SEA + filter) passed.
  console.log(`\n==> starting relay (GUN_DIR=${gunDir})`);
  run('relay', 'yarn', ['workspace', '@avalon/server', 'start'], {
    env: { PORT: String(RELAY_PORT), HOST: '127.0.0.1', GUN_DIR: gunDir },
  });
  await waitForPort(RELAY_PORT, 'relay');
  await checkRelay();

  // 2. Vite dev server; client/vite.config.mjs proxies /gun (websocket) and
  //    /api to the relay on :8001.
  const viteEnv = {
    VITE_RELAY_TARGET: RELAY_URL,
    VITE_API_TARGET: RELAY_URL,
  };

  // Pre-bundle deps up front. Otherwise the dev server starts optimizing on the
  // first request and the in-flight module graph 404s underneath the browser,
  // which surfaces as spurious "disallowed MIME type" errors in the tests.
  console.log('\n==> pre-bundling client dependencies');
  await new Promise((resolve, reject) => {
    const opt = spawn('yarn', ['workspace', '@avalon/client', 'exec', 'vite', 'optimize', '--force'], {
      cwd: repoRoot,
      env: { ...process.env, ...viteEnv },
      stdio: 'inherit',
    });
    opt.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`vite optimize failed (exit ${c})`))));
  });

  console.log('\n==> starting vite dev server');
  run('vite', 'yarn', ['workspace', '@avalon/client', 'dev', '--port', String(VITE_PORT), '--strictPort'], {
    env: viteEnv,
  });
  await waitForPort(VITE_PORT, 'vite dev server');
  await warmUp();

  // 3. Run each test against the stack.
  let failed = 0;
  for (const { file, label, env } of runs) {
    console.log(`\n${'='.repeat(60)}\n==> ${label}\n${'='.repeat(60)}`);
    const code = await new Promise((resolve) => {
      const t = spawn(process.execPath, [file], {
        cwd: repoRoot,
        env: { ...process.env, RELAY_URL, ...env },
        stdio: 'inherit',
      });
      t.on('exit', (c) => resolve(c ?? 1));
    });
    if (code === 0) {
      console.log(`\n==> ${label}: PASS`);
    } else {
      console.error(`\n==> ${label}: FAIL (exit ${code})`);
      failed++;
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(failed === 0 ? `All ${runs.length} e2e run(s) passed` : `${failed} of ${runs.length} e2e run(s) failed`);
  await shutdown(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\nFAIL:', err.message);
  await shutdown(1);
});
