// Brings up a throwaway local Avalon stack and runs the e2e suite against it.
//
//   Firebase emulators (auth :9099, firestore :9080)
//        ^                      ^
//        |                      |
//   API server :8001 <---- /api proxy ---- vite dev :5173 <---- Playwright
//
// Nothing here talks to the live project: the client is built with
// VITE_USE_EMULATORS so the Firebase JS SDK is redirected at the emulators,
// and vite proxies /api at the locally running server instead of avalon.onl.
//
// Usage:  node tests/e2e-stack.mjs [test-file ...]
// Defaults to running every tests/e2e-*.mjs file except this one.

import { spawn } from 'child_process';
import { createConnection } from 'net';
import { readdirSync } from 'fs';
import { dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');

const PROJECT = 'georgyo-avalon';
const AUTH_PORT = 9099;
const FIRESTORE_PORT = 9080;
const SERVER_PORT = 8001;
const VITE_PORT = 5173;

const emulatorEnv = {
  GCLOUD_PROJECT: PROJECT,
  FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${AUTH_PORT}`,
  FIRESTORE_EMULATOR_HOST: `127.0.0.1:${FIRESTORE_PORT}`,
};

const children = [];
let shuttingDown = false;

function run(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: opts.cwd || repoRoot,
    env: { ...process.env, ...(opts.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
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
// emulators and the API server bind 127.0.0.1. Probe both families and remember
// which one answered so later HTTP requests use a reachable address.
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

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n==> shutting down local stack');
  for (const { name, child } of children.reverse()) {
    if (child.exitCode === null) {
      console.log(`  stopping ${name}`);
      child.kill('SIGTERM');
    }
  }
  // Give them a moment to exit cleanly, then force.
  await new Promise((r) => setTimeout(r, 2000));
  for (const { child } of children) if (child.exitCode === null) child.kill('SIGKILL');
  process.exit(code);
}

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));

async function main() {
  const requested = process.argv.slice(2);
  const testFiles = requested.length
    ? requested
    : readdirSync(__dirname)
        .filter((f) => f.startsWith('e2e-') && f.endsWith('.mjs') && f !== basename(__filename))
        .sort()
        .map((f) => join(__dirname, f));

  console.log('==> tests to run:');
  for (const f of testFiles) console.log(`      ${basename(f)}`);

  // 0. @avalon/common resolves to dist/, so it has to be compiled before the
  //    server or the client can import it.
  console.log('\n==> building @avalon/common');
  await new Promise((resolve, reject) => {
    const b = spawn('yarn', ['build:common'], { cwd: repoRoot, env: process.env, stdio: 'inherit' });
    b.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`yarn build:common failed (exit ${c})`))));
  });

  // 1. Firebase emulators (auth + firestore). Needs a JDK on PATH.
  console.log('\n==> starting Firebase emulators');
  run('emulators', 'yarn', [
    'workspace', 'functions', 'exec',
    'firebase', 'emulators:start',
    '--only', 'auth,firestore',
    '--project', PROJECT,
  ], { cwd: join(repoRoot, 'firebase') });

  await waitForPort(FIRESTORE_PORT, 'firestore emulator');
  await waitForPort(AUTH_PORT, 'auth emulator');

  // 2. API server, pointed at the emulators (no service account needed).
  console.log('\n==> starting API server');
  run('server', 'yarn', ['workspace', '@avalon/server', 'start'], {
    env: { ...emulatorEnv, PORT: String(SERVER_PORT) },
  });
  await waitForPort(SERVER_PORT, 'api server');

  // 3. Vite dev server, proxying /api at the local server and building the
  //    client with the emulator hooks switched on.
  const viteEnv = {
    VITE_API_TARGET: `http://127.0.0.1:${SERVER_PORT}`,
    VITE_USE_EMULATORS: 'true',
    VITE_AUTH_EMULATOR_URL: `http://127.0.0.1:${AUTH_PORT}`,
    VITE_FIRESTORE_EMULATOR_HOST: `127.0.0.1:${FIRESTORE_PORT}`,
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

  // 4. Run each test against the stack.
  let failed = 0;
  for (const file of testFiles) {
    const name = basename(file);
    console.log(`\n${'='.repeat(60)}\n==> ${name}\n${'='.repeat(60)}`);
    const code = await new Promise((resolve) => {
      const t = spawn(process.execPath, [file], {
        cwd: repoRoot,
        env: { ...process.env, ...emulatorEnv },
        stdio: 'inherit',
      });
      t.on('exit', (c) => resolve(c ?? 1));
    });
    if (code === 0) {
      console.log(`\n==> ${name}: PASS`);
    } else {
      console.error(`\n==> ${name}: FAIL (exit ${code})`);
      failed++;
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(failed === 0 ? `All ${testFiles.length} e2e test(s) passed` : `${failed} of ${testFiles.length} e2e test(s) failed`);
  await shutdown(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\nFAIL:', err.message);
  await shutdown(1);
});
