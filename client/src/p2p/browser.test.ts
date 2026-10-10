/**
 * Browser-only code paths in Chromium (Playwright): IndexedDB KV, the module
 * crypto worker, and two tabs contending for the real Web Lock with
 * P2PSession's browser defaults (IndexedDB, navigator.locks, WorkerPool,
 * location.origin for the relay). The test bundle is built with esbuild and
 * served by the in-process relay (same origin as /gun and /api/relay-info).
 *
 * Skipped when no Chromium is found (AVALON_CHROMIUM, /opt/pw-browsers or
 * Playwright's own installation).
 */
import { TestRelay } from './relayHarness.ts';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';

const here = fileURLToPath(new URL('.', import.meta.url));

function findChromium(): string | null {
  const env = process.env.AVALON_CHROMIUM;
  if (env !== undefined && existsSync(env)) return env;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (existsSync(root)) {
    for (const d of readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
      const p = join(root, d, 'chrome-linux', 'chrome');
      if (existsSync(p)) return p;
    }
  }
  try {
    const p = chromium.executablePath();
    if (existsSync(p)) return p;
  } catch {
    // not installed
  }
  return null;
}

async function bundle(entry: string): Promise<string> {
  const r = await build({
    entryPoints: [join(here, entry)], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
    logLevel: 'silent', define: { 'process.env.NODE_ENV': '"test"' },
  });
  return r.outputFiles[0].text;
}

type Api = Record<string, (...args: unknown[]) => unknown>;

async function call(page: Page, fn: string, ...args: unknown[]): Promise<unknown> {
  return page.evaluate(([f, a]) => {
    const api = (globalThis as unknown as { avalonTest: Api }).avalonTest;
    return api[f as string](...(a as unknown[]));
  }, [fn, args] as const);
}

async function until(cond: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timeout waiting for ' + what);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const exe = findChromium();

describe('browser runtime (Chromium)', { skip: exe === null ? 'no Chromium found' : false }, () => {
  let relay: TestRelay;
  let browser: Browser;

  before(async () => {
    relay = await TestRelay.start();
    const [entry, worker] = await Promise.all([bundle('browserEntry.ts'), bundle('crypto.worker.ts')]);
    relay.files.set('/', { type: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>t</title><script type="module" src="/entry.js"></script>' });
    relay.files.set('/entry.js', { type: 'text/javascript', body: entry });
    // the bundle keeps `new URL('./crypto.worker.ts', import.meta.url)`: serve the worker bundle there
    relay.files.set('/crypto.worker.ts', { type: 'text/javascript', body: worker });
    browser = await chromium.launch({ executablePath: exe ?? undefined, headless: true, args: ['--no-proxy-server'] });
  });

  after(async () => {
    await browser?.close();
    await relay?.close();
  });

  const newPage = async (ctx: Awaited<ReturnType<Browser['newContext']>>): Promise<Page> => {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('pageerror', e.message));
    page.on('console', (m) => { if (process.env.AVALON_DEBUG) console.log('console', m.text()); });
    await page.goto(relay.url + '/');
    await page.waitForFunction(() => 'avalonTest' in globalThis);
    return page;
  };

  it('IndexedDB KV: atomic putIfAbsent, journal by scope in slot order, transcript index, verdicts, clear', async () => {
    const ctx = await browser.newContext();
    const page = await newPage(ctx);
    const r = await call(page, 'idb') as Record<string, unknown>;
    assert.deepEqual(r.race, ['first', 'first']);
    assert.deepEqual(r.journal, ['d', 'first', 's0']);
    assert.deepEqual(r.other, ['other']);
    assert.deepEqual(r.scope, ['AV1.1']);
    assert.deepEqual(r.verdicts, [['e'.repeat(64), { ok: false, reason: 'bad' }]]);
    assert.deepEqual(r.profile, { name: null, lobbyCode: null, lobbyId: null });
    assert.deepEqual(r.afterClear, []);
    await ctx.close();
  });

  it('the module crypto worker verifies like runJobs and reports task errors', async () => {
    const ctx = await browser.newContext();
    const page = await newPage(ctx);
    const r = await call(page, 'worker') as Record<string, unknown>;
    assert.equal(r.same, true);
    assert.equal(r.n, 3);
    assert.match(String(r.proveError), /unknown task/);
    await ctx.close();
  });

  it('two tabs: one writer (Web Locks), Use here moves it, both share the IndexedDB identity', async () => {
    const ctx = await browser.newContext();
    const a = await newPage(ctx);
    assert.notEqual(await call(a, 'open'), 'READ_ONLY_OTHER_TAB');
    const uid = await call(a, 'createIdentity');
    assert.equal(typeof uid, 'string');
    await until(async () => (await call(a, 'connected')) === true, 10000, 'tab A connected: ' + JSON.stringify(await call(a, 'peers')));
    const code = await call(a, 'createLobby', 'ALICE');
    assert.match(String(code), /^[A-HJ-NP-TV-Z]{4}$/);
    const b = await newPage(ctx);
    assert.equal(await call(b, 'open'), 'READ_ONLY_OTHER_TAB');
    assert.match(String(await call(b, 'tryCreateIdentity')), /another tab/);
    assert.notEqual(await call(b, 'useHere'), 'READ_ONLY_OTHER_TAB');
    await until(async () => (await call(a, 'status')) === 'READ_ONLY_OTHER_TAB', 5000, 'tab A read-only');
    const profile = await call(b, 'profile') as { uid: string; lobby: string | null };
    assert.equal(profile.uid, uid);
    assert.equal(profile.lobby, code);
    // closing the writer hands the lock back to the waiting tab
    await b.close();
    await until(async () => (await call(a, 'status')) !== 'READ_ONLY_OTHER_TAB', 10000, 'tab A writer again');
    await ctx.close();
  });
});
