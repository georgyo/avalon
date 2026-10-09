// Relay tests (docs/p2p-protocol.md §8, §12 "Relay (WP-E)"):
//   * the input filter: whitelist, sizes, per-connection rate, gets and local
//     reads unfiltered;
//   * the boot self-test: passes on the full build, fails without the filter
//     and without SEA (exit 1), both in-process and as the entry point does it;
//   * server.ts (tsx) and the esbuild bundle outside node_modules: self-test,
//     /healthz, /api/relay-info, two-client smoke test, no stats file written;
//     a bundle without gun-shim exits 1.
//
//   yarn workspace @avalon/server test

import './gun-shim';
import Gun from 'gun';
import 'gun/sea';
import type { IGunInstance } from 'gun';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { build } from 'esbuild';
import { bundleOptions } from './bundle';
import {
  RELAY_LIMITS,
  checkPut,
  createRelay,
  installRelayFilter,
  isSeaSignedString,
  runRelaySelfTest,
  type GunFactory,
  type RelayFilter,
} from './relay';
import { runSmoke } from './smoke';

const here = path.dirname(fileURLToPath(import.meta.url));
const gunDir = path.dirname(fileURLToPath(import.meta.resolve('gun/gun.js')));
const tsxLoader = import.meta.resolve('tsx');
const GunCtor = Gun as unknown as GunFactory;

const scratch = mkdtempSync(path.join(tmpdir(), 'avalon-relay-test-'));
after(() => {
  rmSync(scratch, { recursive: true, force: true });
  // Closed GUN instances keep finite timers (20 s websocket heartbeats, dedup
  // and radisk timers). Do not wait for them: exit with the runner's verdict
  // (node:test sets process.exitCode on failure).
  setTimeout(() => process.exit(), 1000).unref();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const av1 = (n = 64): string => 'AV1.' + randomBytes(n).toString('base64url') + '.' + randomBytes(64).toString('base64url');
const PUB = 'A'.repeat(43) + '.' + 'b'.repeat(43);
const LOBBY = 'avalon/v1/lobby/ABCD#';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function node(soul: string, entries: Record<string, unknown>, state = 1): Record<string, unknown> {
  const states: Record<string, number> = {};
  for (const k of Object.keys(entries)) states[k] = state;
  return { _: { '#': soul, '>': states }, ...entries };
}
function put(soul: string, entries: Record<string, unknown>): Record<string, unknown> {
  return { [soul]: node(soul, entries) };
}
function hashed(soul: string, value: string): Record<string, unknown> {
  return put(soul, { [sha256Hex(value)]: value });
}
function presence(value: string): string {
  return JSON.stringify({ ':': value, '~': randomBytes(64).toString('base64') });
}

interface Root {
  graph: Record<string, Record<string, unknown> | undefined>;
  opt: {
    peers: Record<string, { defer?: ReturnType<typeof setTimeout>; wire?: { readyState?: number; send?(s: string): void; close?(): void } | null } | undefined>;
    mesh?: { say(msg: Record<string, unknown>): unknown };
    ws?: { web?: { clients?: Set<{ terminate(): void }>; close(): void } };
  };
}
const rootOf = (g: IGunInstance): Root => (g as unknown as { _: Root })._;

async function until(cond: () => boolean, ms = 5000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(20);
  }
}

interface TestRelay {
  gun: IGunInstance;
  root: Root;
  server: Server;
  url: string;
  filter: RelayFilter;
  clock: { t: number };
  close(): Promise<void>;
}

async function startRelay(file: string): Promise<TestRelay> {
  const server = createServer((_q, s) => { s.statusCode = 404; s.end(); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const gun = createRelay(server, file, GunCtor);
  const clock = { t: 1_000_000 };
  const filter = installRelayFilter(gun, { now: () => clock.t });
  const root = rootOf(gun);
  return {
    gun, root, server, filter, clock, url: `http://127.0.0.1:${port}/gun`,
    close: () => new Promise<void>((resolve) => {
      for (const c of root.opt.ws?.web?.clients ?? []) c.terminate();
      root.opt.ws?.web?.close();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

interface TestClient {
  gun: IGunInstance;
  root: Root;
  say(put: Record<string, unknown>): void;
  close(): void;
}

async function connect(url: string): Promise<TestClient> {
  const gun = GunCtor({
    peers: [url], super: false, localStorage: false, radisk: false, rfs: false, multicast: false, axe: false, stats: false,
  });
  const root = rootOf(gun);
  await until(() => Object.values(root.opt.peers).some((p) => p?.wire?.readyState === 1), 5000, 'client connection');
  return {
    gun, root,
    say: (p) => { root.opt.mesh?.say({ '#': randomBytes(9).toString('base64url'), put: p }); },
    close: () => {
      for (const [k, p] of Object.entries(root.opt.peers)) {
        delete root.opt.peers[k];
        clearTimeout(p?.defer);
        p?.wire?.close?.();
      }
    },
  };
}

function statsFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.startsWith('stats.')).sort();
  } catch {
    return [];
  }
}

interface Proc {
  child: ChildProcess;
  out: () => string;
  exit: Promise<number | null>;
}

function startProc(args: string[], opts: { cwd: string; env?: Record<string, string> }): Proc {
  const child = spawn(process.execPath, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
  child.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
  const exit = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, out: () => out, exit };
}

async function listeningPort(p: Proc, ms = 30000): Promise<number> {
  await until(() => /listening on port \d+/.test(p.out()) || p.child.exitCode !== null, ms, 'server to listen');
  const m = /listening on port (\d+)/.exec(p.out());
  if (!m) throw new Error(`server did not start:\n${p.out()}`);
  return Number(m[1]);
}

async function stop(p: Proc): Promise<number | null> {
  if (p.child.exitCode === null) p.child.kill('SIGTERM');
  return p.exit;
}

// ---------------------------------------------------------------------------
// checkPut (pure)
// ---------------------------------------------------------------------------

describe('checkPut', () => {
  const gameId = 'abcdefghijklmnopqrstuv'; // 22 chars
  const accepted: [string, Record<string, unknown>][] = [
    ['lobby value', hashed(LOBBY, av1())],
    ['game setup value', hashed(`avalon/v1/game/${gameId}/setup#`, av1())],
    ['game play value', hashed(`avalon/v1/game/${gameId.replace('a', '-')}/play#`, av1())],
    ['log value', hashed('avalon/v1/logs/2026-10#', av1())],
    ['value of exactly 64 KiB', hashed(LOBBY, 'AV1.' + 'x'.repeat(64 * 1024 - 4))],
    ['several values in one node', put(LOBBY, { [sha256Hex('AV1.a')]: 'AV1.a', [sha256Hex('AV1.b')]: 'AV1.b' })],
    ['several nodes', { ...hashed(LOBBY, av1()), ...hashed('avalon/v1/lobby/ZZZZ#', av1()) }],
    ['presence', put('~' + PUB, { avalon_v1_presence: presence('{"seq":1}') })],
    ['presence with SEA prefix', put('~' + PUB, { avalon_v1_presence: 'SEA' + presence('x') })],
  ];
  for (const [name, p] of accepted) {
    it(`accepts ${name}`, () => assert.deepEqual(checkPut(p).ok, true));
  }

  const rejected: [string, unknown, string][] = [
    ['non-whitelisted soul', hashed('avalon/v1/selftest#', av1()), 'soul not whitelisted'],
    ['soul without #', hashed('avalon/v1/lobby/ABCD', av1()), 'soul not whitelisted'],
    ['lower-case lobby code', hashed('avalon/v1/lobby/abcd#', av1()), 'soul not whitelisted'],
    ['lobby code with I', hashed('avalon/v1/lobby/ABCI#', av1()), 'soul not whitelisted'],
    ['lobby code with O', hashed('avalon/v1/lobby/OBCD#', av1()), 'soul not whitelisted'],
    ['lobby code with U', hashed('avalon/v1/lobby/ABUD#', av1()), 'soul not whitelisted'],
    ['5-letter code', hashed('avalon/v1/lobby/ABCDE#', av1()), 'soul not whitelisted'],
    ['short game id', hashed('avalon/v1/game/abc/setup#', av1()), 'soul not whitelisted'],
    ['unknown game category', hashed(`avalon/v1/game/${gameId}/chat#`, av1()), 'soul not whitelisted'],
    ['bad log month', hashed('avalon/v1/logs/2026-1#', av1()), 'soul not whitelisted'],
    ['other app data', hashed('chat/messages', av1()), 'soul not whitelisted'],
    ['SEA alias list', put('~@alice', { '~alice': 'x' }), 'soul not whitelisted'],
    ['user space with a path', put('~' + PUB + '/x', { avalon_v1_presence: presence('x') }), 'soul not whitelisted'],
    ['upper-case hex key', put(LOBBY, { [sha256Hex('AV1.a').toUpperCase()]: 'AV1.a' }), 'key is not a SHA-256 hex digest'],
    ['short key', put(LOBBY, { abc: 'AV1.a' }), 'key is not a SHA-256 hex digest'],
    ['value without AV1. prefix', hashed(LOBBY, 'AV2.xyz'), 'value is not an AV1 envelope'],
    ['non-string value', put(LOBBY, { [sha256Hex('1')]: 1 }), 'value is not a string'],
    ['null value (delete)', put(LOBBY, { [sha256Hex('AV1.a')]: null }), 'value is not a string'],
    ['link value', put(LOBBY, { [sha256Hex('AV1.a')]: { '#': 'x' } }), 'value is not a string'],
    ['value over 64 KiB', hashed(LOBBY, 'AV1.' + 'x'.repeat(64 * 1024 - 3)), 'value too large'],
    ['message over 256 KiB', put(LOBBY, Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => { const v = 'AV1.' + String(i) + 'x'.repeat(60 * 1024); return [sha256Hex(v), v]; }),
    )), 'message too large'],
    ['other user-space key', put('~' + PUB, { alias: presence('x') }), 'user space key not whitelisted'],
    ['presence plus another key', put('~' + PUB, { avalon_v1_presence: presence('x'), pub: PUB }), 'user space key not whitelisted'],
    ['unsigned presence', put('~' + PUB, { avalon_v1_presence: '{"seq":1}' }), 'presence value is not SEA-signed'],
    ['presence over 1 KiB', put('~' + PUB, { avalon_v1_presence: presence('x'.repeat(1024)) }), 'presence value too large'],
    ['node meta naming another soul', { [LOBBY]: { ...node('avalon/v1/lobby/ZZZZ#', { [sha256Hex('AV1.a')]: 'AV1.a' }) } }, 'node meta does not name its soul'],
    ['node without meta', { [LOBBY]: { [sha256Hex('AV1.a')]: 'AV1.a' } }, 'node meta does not name its soul'],
    ['node without states', { [LOBBY]: { _: { '#': LOBBY }, [sha256Hex('AV1.a')]: 'AV1.a' } }, 'node has no states'],
    ['state without value', { [LOBBY]: { _: { '#': LOBBY, '>': { [sha256Hex('AV1.a')]: 1, x: 1 } }, [sha256Hex('AV1.a')]: 'AV1.a' } }, 'state without value'],
    ['non-numeric state', { [LOBBY]: { _: { '#': LOBBY, '>': { [sha256Hex('AV1.a')]: '1' } }, [sha256Hex('AV1.a')]: 'AV1.a' } }, 'missing or bad state'],
    ['empty node', { [LOBBY]: { _: { '#': LOBBY, '>': {} } } }, 'empty node'],
    ['empty put', {}, 'empty put'],
    ['non-object put', 'x', 'put is not an object'],
    ['array node', { [LOBBY]: [] }, 'node is not an object'],
    ['one bad node among good ones', { ...hashed(LOBBY, av1()), ...hashed('avalon/v1/selftest#', av1()) }, 'soul not whitelisted'],
    ['single-key form', { '#': LOBBY, '.': sha256Hex('AV1.a'), ':': 'AV1.a', '>': 1 }, 'node is not an object'],
  ];
  for (const [name, p, reason] of rejected) {
    it(`rejects ${name}`, () => assert.deepEqual(checkPut(p), { ok: false, reason }));
  }

  it('recognises SEA-signed strings by shape', () => {
    assert.equal(isSeaSignedString(presence('x')), true);
    assert.equal(isSeaSignedString('SEA' + presence('x')), true);
    assert.equal(isSeaSignedString('{"m":"x","s":"y"}'), false);
    assert.equal(isSeaSignedString('{":":"x","~":""}'), false);
    assert.equal(isSeaSignedString('{":"'), false);
    assert.equal(isSeaSignedString('[1]'), false);
  });
});

// ---------------------------------------------------------------------------
// The filter on a live relay
// ---------------------------------------------------------------------------

describe('relay filter (in-process relay with gun/sea)', () => {
  it('stores only whitelisted, well-formed values; SEA rejects wrong keys and overwrites', async () => {
    const relay = await startRelay(path.join(scratch, 'f1'));
    const c = await connect(relay.url);
    try {
      const good = av1();
      const wrongKey = sha256Hex(good + 'x');
      const sneaky = av1();
      const huge = 'AV1.' + 'y'.repeat(64 * 1024);
      c.say(hashed(LOBBY, good));
      c.say(put(LOBBY, { [wrongKey]: av1() }));                                // passes the filter, SEA rejects
      c.say(hashed('avalon/v1/selftest#', sneaky));                            // not whitelisted
      c.say(hashed(LOBBY, huge));                                              // too large
      c.say(put('~' + PUB, { avalon_v1_presence: 'plain' }));                  // not SEA-signed
      c.say(put('~' + PUB, { other: presence('x') }));                         // not whitelisted key
      await until(() => relay.filter.stats.accepted + relay.filter.stats.dropped >= 6, 5000, 'filter verdicts');
      await sleep(300);
      assert.equal(relay.root.graph[LOBBY]?.[sha256Hex(good)], good);
      assert.equal(relay.root.graph[LOBBY]?.[wrongKey], undefined);
      assert.equal(relay.root.graph['avalon/v1/selftest#'], undefined);
      assert.equal(relay.root.graph[LOBBY]?.[sha256Hex(huge)], undefined);
      assert.equal(relay.root.graph['~' + PUB], undefined);
      assert.equal(relay.filter.stats.accepted, 2);
      assert.deepEqual(relay.filter.stats.reasons, {
        'soul not whitelisted': 1,
        'value too large': 1,
        'presence value is not SEA-signed': 1,
        'user space key not whitelisted': 1,
      });

      // Overwrite of the stored value: passes the filter (well-formed), SEA keeps the original.
      c.say(put(LOBBY, { [sha256Hex(good)]: av1() }));
      await until(() => relay.filter.stats.accepted === 3, 5000, 'overwrite verdict');
      await sleep(300);
      assert.equal(relay.root.graph[LOBBY]?.[sha256Hex(good)], good);
    } finally {
      c.close();
      await relay.close();
    }
  });

  it('accepts a real SEA-signed presence write and serves it to another client', async () => {
    const relay = await startRelay(path.join(scratch, 'f2'));
    const a = await connect(relay.url);
    const b = await connect(relay.url);
    try {
      const SEA = (Gun as unknown as { SEA: { pair(): Promise<{ pub: string; priv: string; epub: string; epriv: string }> } }).SEA;
      const pair = await SEA.pair();
      type Chain = { get(k: string): Chain; put(v: string): Chain; on(cb: (v: unknown) => void): Chain };
      type UserChain = Chain & { auth(p: typeof pair, cb: (ack: { err?: string }) => void): void };
      const userOf = (g: IGunInstance): UserChain => (g as unknown as { user(): UserChain }).user();
      await new Promise<void>((resolve, reject) => userOf(a.gun).auth(pair, (ack) => (ack.err ? reject(new Error(ack.err)) : resolve())));
      let got: unknown;
      (b.gun as unknown as Chain).get('~' + pair.pub).get('avalon_v1_presence').on((v) => { got = v; });
      userOf(a.gun).get('avalon_v1_presence').put('{"seq":1,"vis":1}');
      await until(() => got === '{"seq":1,"vis":1}', 5000, 'presence delivery');
      const stored = relay.root.graph['~' + pair.pub]?.avalon_v1_presence;
      assert.equal(typeof stored, 'string');
      assert.equal(isSeaSignedString(stored as string), true);
      assert.equal(relay.filter.stats.dropped, 0);
    } finally {
      a.close();
      b.close();
      await relay.close();
    }
  });

  it('limits puts per connection to a burst of 200 and 50/s', async () => {
    const relay = await startRelay(path.join(scratch, 'f3'));
    const a = await connect(relay.url);
    const b = await connect(relay.url);
    try {
      for (let i = 0; i < 230; i++) a.say(hashed(LOBBY, av1(8)));
      await until(() => relay.filter.stats.accepted + relay.filter.stats.dropped === 230, 10000, '230 verdicts');
      assert.equal(relay.filter.stats.accepted, RELAY_LIMITS.burst);
      assert.equal(relay.filter.stats.reasons['rate limit'], 30);

      relay.clock.t += 1000; // refills 50 tokens
      for (let i = 0; i < 60; i++) a.say(hashed(LOBBY, av1(8)));
      await until(() => relay.filter.stats.accepted + relay.filter.stats.dropped === 290, 10000, '290 verdicts');
      assert.equal(relay.filter.stats.accepted, 250);
      assert.equal(relay.filter.stats.reasons['rate limit'], 40);

      // Another connection has its own bucket.
      for (let i = 0; i < 10; i++) b.say(hashed(LOBBY, av1(8)));
      await until(() => relay.filter.stats.accepted + relay.filter.stats.dropped === 300, 10000, '300 verdicts');
      assert.equal(relay.filter.stats.accepted, 260);
    } finally {
      a.close();
      b.close();
      await relay.close();
    }
  });

  it('closes a connection that sends a frame over the hard frame limit', async () => {
    const relay = await startRelay(path.join(scratch, 'f4'));
    const c = await connect(relay.url);
    try {
      const wire = Object.values(c.root.opt.peers).find((p) => p?.wire)?.wire;
      assert.ok(wire?.send);
      wire.send(JSON.stringify({ '#': 'big', put: hashed(LOBBY, 'AV1.' + 'z'.repeat(RELAY_LIMITS.frameBytes)) }));
      await until(() => wire.readyState === 3, 5000, 'connection close');
      assert.equal(relay.filter.stats.accepted, 0);
    } finally {
      c.close();
      await relay.close();
    }
  });

  it('does not filter gets, nor values the relay reads back from its disk', async () => {
    const file = path.join(scratch, 'f5');
    const relay = await startRelay(file);
    const writer = await connect(relay.url);
    const values = [av1(), av1(), av1()];
    try {
      for (const v of values) writer.say(hashed(LOBBY, v));
      await until(() => values.every((v) => relay.root.graph[LOBBY]?.[sha256Hex(v)] === v), 5000, 'stored values');
      await sleep(600); // radisk flush
    } finally {
      writer.close();
      await relay.close();
    }
    // A new relay process image on the same directory, with the filter installed:
    // the values come from disk through the local `in` path and reach a reader.
    const relay2 = await startRelay(file);
    const reader = await connect(relay2.url);
    try {
      const got = new Set<string>();
      type Chain = { get(k: string): Chain; map(): Chain; on(cb: (v: unknown) => void): Chain };
      (reader.gun as unknown as Chain).get(LOBBY).map().on((v) => { if (typeof v === 'string') got.add(v); });
      await until(() => values.every((v) => got.has(v)), 5000, 'values served from disk');
      assert.equal(relay2.filter.stats.dropped, 0);
    } finally {
      reader.close();
      await relay2.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The boot self-test
// ---------------------------------------------------------------------------

describe('relaySelfTest', () => {
  it('passes every §8 case on the full build', async () => {
    const report = await runRelaySelfTest({ Gun: GunCtor, tmpRoot: scratch });
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.passed, [
      'SEA is loaded (Gun.SEA exists)',
      '(a) value under a wrong hash key is rejected',
      '(b) presence value with a bad signature is rejected',
      '(c) valid lobby value is stored',
      '(c) overwrite of a stored value is rejected',
      '(filter) correctly hashed value under a non-whitelisted soul is rejected',
      '(filter) valid lobby value is stored',
    ]);
    assert.deepEqual(readdirSync(scratch).filter((f) => f.startsWith('avalon-relay-selftest-')), []);
  });

  it('fails when the filter is not installed', async () => {
    const report = await runRelaySelfTest({ Gun: GunCtor, tmpRoot: scratch, installFilter: () => undefined });
    assert.deepEqual(report.failures, ['(filter) correctly hashed value under a non-whitelisted soul is rejected']);
  });

  const fixture = (name: string, ...args: string[]): Proc =>
    startProc(['--import', tsxLoader, path.join(here, 'fixtures', name), ...args], { cwd: here });

  it('exits 0 as the entry point runs it (tsx, full build)', async () => {
    const p = fixture('selftest.ts');
    assert.equal(await p.exit, 0, p.out());
    assert.match(p.out(), /SELFTEST PASS/);
  });

  it('exits 1 when the filter is not installed', async () => {
    const p = fixture('selftest.ts', 'nofilter');
    assert.equal(await p.exit, 1, p.out());
    assert.match(p.out(), /non-whitelisted soul/);
  });

  it('exits 1 when SEA is not loaded (wrong key, bad signature and overwrite all stored)', async () => {
    const p = fixture('selftest-nosea.ts');
    assert.equal(await p.exit, 1, p.out());
    for (const re of [/SEA is loaded/, /\(a\) value under a wrong hash key/, /\(b\) presence value with a bad signature/, /\(c\) overwrite/]) {
      assert.match(p.out(), re);
    }
    assert.doesNotMatch(p.out(), /\(c\) valid lobby value is stored/);
    assert.doesNotMatch(p.out(), /\(filter\)/);
  });
});

// ---------------------------------------------------------------------------
// server.ts and the bundle
// ---------------------------------------------------------------------------

async function checkRunningServer(p: Proc, cwd: string, gunData: string): Promise<void> {
  const port = await listeningPort(p);
  assert.match(p.out(), /Relay self-test passed/);
  const base = `http://127.0.0.1:${port}`;

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok');

  const before = Date.now();
  const info = await fetch(`${base}/api/relay-info`).then((r) => r.json() as Promise<{ bootId: unknown; now: unknown }>);
  assert.equal(typeof info.bootId, 'string');
  assert.match(info.bootId as string, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(typeof info.now, 'number');
  assert.ok(Math.abs((info.now as number) - before) < 5000);
  const again = await fetch(`${base}/api/relay-info`).then((r) => r.json() as Promise<{ bootId: unknown }>);
  assert.equal(again.bootId, info.bootId);

  assert.equal((await fetch(`${base}/api/login`, { method: 'POST' })).status, 404);

  const smoke = await runSmoke(base, 3);
  assert.deepEqual(smoke.failures, [], JSON.stringify(smoke));
  assert.ok(smoke.published >= 10 && smoke.delivered === smoke.published);

  // lib/stats.js writes `stats.<GUN_DIR basename>` every 5 s unless disabled.
  await sleep(5500);
  assert.equal(p.child.exitCode, null, p.out());
  assert.deepEqual(readdirSync(cwd).filter((f) => f !== path.basename(gunData) && f !== 'server.js').sort(), []);
  assert.deepEqual(statsFiles(path.dirname(cwd)), []);
}

describe('server entry point', () => {
  it('server.ts (tsx): self-test, /healthz, /api/relay-info, two-client smoke, no stats file', async () => {
    const cwd = mkdtempSync(path.join(scratch, 'srv-'));
    const gunData = path.join(cwd, 'gundata');
    const statsBefore = statsFiles(gunDir);
    const p = startProc(['--import', tsxLoader, path.join(here, 'server.ts')], {
      cwd, env: { PORT: '0', GUN_DIR: gunData, HOST: '127.0.0.1' },
    });
    try {
      await checkRunningServer(p, cwd, gunData);
      assert.deepEqual(statsFiles(gunDir), statsBefore);
      assert.deepEqual(statsFiles(here), []);
    } finally {
      assert.equal(await stop(p), 0, p.out());
    }
    // A restart has a new bootId.
    const p2 = startProc(['--import', tsxLoader, path.join(here, 'server.ts')], {
      cwd, env: { PORT: '0', GUN_DIR: gunData, HOST: '127.0.0.1' },
    });
    try {
      const port = await listeningPort(p2);
      const info = await fetch(`http://127.0.0.1:${port}/api/relay-info`).then((r) => r.json() as Promise<{ bootId: string }>);
      assert.match(info.bootId, /^[A-Za-z0-9_-]{22}$/);
      assert.ok(!p.out().includes(info.bootId));
    } finally {
      await stop(p2);
    }
  });

  it('esbuild bundle runs outside node_modules: self-test, endpoints, smoke, no stats file', async () => {
    const dir = mkdtempSync(path.join(scratch, 'bundle-'));
    const outfile = path.join(dir, 'server.js');
    await build(bundleOptions(outfile));
    const gunData = path.join(dir, 'gundata');
    const p = startProc([outfile], { cwd: dir, env: { PORT: '0', GUN_DIR: gunData, HOST: '127.0.0.1' } });
    try {
      await checkRunningServer(p, dir, gunData);
    } finally {
      assert.equal(await stop(p), 0, p.out());
    }
  });

  it('a bundle without gun-shim (SEA broken) exits 1 and never listens', async () => {
    const dir = mkdtempSync(path.join(scratch, 'noshim-'));
    const outfile = path.join(dir, 'server.js');
    await build({
      ...bundleOptions(outfile),
      logLevel: 'silent',
      plugins: [{
        name: 'no-gun-shim',
        setup(b) {
          b.onLoad({ filter: /gun-shim\.ts$/ }, () => ({
            contents: "import Gun from 'gun/gun.js'; export default Gun;", loader: 'ts', resolveDir: here,
          }));
        },
      }],
    });
    const p = startProc([outfile], { cwd: dir, env: { PORT: '0', GUN_DIR: path.join(dir, 'gundata'), HOST: '127.0.0.1' } });
    const code = await Promise.race([p.exit, sleep(30000).then(() => 'timeout' as const)]);
    if (code === 'timeout') p.child.kill('SIGKILL');
    assert.equal(code, 1, p.out());
    assert.doesNotMatch(p.out(), /listening on port/);
  });
});
