// The untrusted GUN relay of docs/p2p-protocol.md §8: the wire input filter
// (`installRelayFilter`) and the boot self-test (`relaySelfTest`).
//
// The relay holds no secret and no game logic. SEA (loaded by the entry point)
// makes it refuse forged user-space writes and `#` writes whose key is not the
// SHA-256 of the value; this filter additionally restricts what the public may
// store at all (a whitelist of souls, value shapes and sizes, and a per-connection
// put rate). Clients re-verify everything themselves (§3.4), so a relay that lost
// either protection could only drop or withhold data, never inject it.

import './gun-shim';
import Gun from 'gun/gun.js';
import * as radiskModule from 'gun/lib/radisk.js';
import type { GunOptions, IGunInstance } from 'gun';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Limits and whitelist (§8, Appendix B)
// ---------------------------------------------------------------------------

export interface RelayLimits {
  /** Maximum UTF-8 size of a value in a public content-addressed soul. */
  valueBytes: number;
  /** Maximum UTF-8 size of the SEA-signed presence value. */
  presenceBytes: number;
  /** Maximum size of the put payload of one GUN message (souls + keys + values). */
  messageBytes: number;
  /** Sustained puts per second per connection. */
  putsPerSecond: number;
  /** Token-bucket burst size per connection. */
  burst: number;
  /**
   * Hard cap on one websocket frame (`ws` `maxPayload`; the connection is
   * closed beyond it). A frame can batch several GUN messages, so it is larger
   * than `messageBytes`, which the filter enforces per message.
   */
  frameBytes: number;
}

export const RELAY_LIMITS: Readonly<RelayLimits> = Object.freeze({
  valueBytes: 64 * 1024,
  presenceBytes: 1024,
  messageBytes: 256 * 1024,
  putsPerSecond: 50,
  burst: 200,
  frameBytes: 1024 * 1024,
});

/** Content-addressed public souls (§3.1). */
export const PUBLIC_SOUL_RE =
  /^avalon\/v1\/(lobby\/[A-HJ-NP-TV-Z]{4}|game\/[A-Za-z0-9_-]{22}\/(setup|play)|logs\/\d{4}-\d{2})#$/;
/** Keys of public souls: hex(SHA-256(value)). */
export const HASH_KEY_RE = /^[0-9a-f]{64}$/;
/** SEA user space of a P-256 public key `x.y`. */
export const USER_SOUL_RE = /^~[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;
/** The only key a user may write in its space (§7.6). */
export const PRESENCE_KEY = 'avalon_v1_presence';
/** Envelope prefix (§3.3). */
export const VALUE_PREFIX = 'AV1.';

// ---------------------------------------------------------------------------
// Put validation (pure)
// ---------------------------------------------------------------------------

export type PutVerdict = { ok: true; bytes: number } | { ok: false; reason: string };

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * True for the string SEA stores for a signed user-space value:
 * `{":": <data>, "~": <signature>}`, optionally prefixed with `SEA`.
 * Only the shape is checked here; SEA verifies the signature.
 */
export function isSeaSignedString(value: string): boolean {
  const json = value.startsWith('SEA{') ? value.slice(3) : value;
  if (!json.startsWith('{')) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return false;
  }
  return isRecord(parsed)
    && Object.prototype.hasOwnProperty.call(parsed, ':')
    && typeof parsed['~'] === 'string'
    && parsed['~'].length > 0;
}

function checkNode(soul: string, node: unknown, limits: RelayLimits): PutVerdict {
  if (!isRecord(node)) return { ok: false, reason: 'node is not an object' };
  const meta = node._;
  if (!isRecord(meta) || meta['#'] !== soul) return { ok: false, reason: 'node meta does not name its soul' };
  const states = meta['>'];
  if (!isRecord(states)) return { ok: false, reason: 'node has no states' };
  const keys = Object.keys(node).filter((k) => k !== '_');
  if (keys.length === 0) return { ok: false, reason: 'empty node' };
  for (const k of Object.keys(states)) {
    if (!keys.includes(k)) return { ok: false, reason: 'state without value' };
  }

  const isPublic = PUBLIC_SOUL_RE.test(soul);
  const isUser = !isPublic && USER_SOUL_RE.test(soul);
  if (!isPublic && !isUser) return { ok: false, reason: 'soul not whitelisted' };
  if (isUser && (keys.length !== 1 || keys[0] !== PRESENCE_KEY)) {
    return { ok: false, reason: 'user space key not whitelisted' };
  }

  let bytes = soul.length;
  for (const key of keys) {
    const state = states[key];
    if (typeof state !== 'number' || !Number.isFinite(state)) return { ok: false, reason: 'missing or bad state' };
    const value = node[key];
    if (typeof value !== 'string') return { ok: false, reason: 'value is not a string' };
    const size = utf8Bytes(value);
    if (isPublic) {
      if (!HASH_KEY_RE.test(key)) return { ok: false, reason: 'key is not a SHA-256 hex digest' };
      if (!value.startsWith(VALUE_PREFIX)) return { ok: false, reason: 'value is not an AV1 envelope' };
      if (size > limits.valueBytes) return { ok: false, reason: 'value too large' };
    } else {
      if (size > limits.presenceBytes) return { ok: false, reason: 'presence value too large' };
      if (!isSeaSignedString(value)) return { ok: false, reason: 'presence value is not SEA-signed' };
    }
    bytes += key.length + size + 32;
  }
  return { ok: true, bytes };
}

/**
 * Validates the `put` of one wire message (GUN graph form
 * `{[soul]: {_: {'#': soul, '>': {[key]: state}}, [key]: value}}`). Every node
 * must pass; one bad node rejects the whole message.
 */
export function checkPut(put: unknown, limits: RelayLimits = RELAY_LIMITS): PutVerdict {
  if (!isRecord(put)) return { ok: false, reason: 'put is not an object' };
  const souls = Object.keys(put);
  if (souls.length === 0) return { ok: false, reason: 'empty put' };
  let bytes = 0;
  for (const soul of souls) {
    const verdict = checkNode(soul, put[soul], limits);
    if (!verdict.ok) return verdict;
    bytes += verdict.bytes;
    if (bytes > limits.messageBytes) return { ok: false, reason: 'message too large' };
  }
  return { ok: true, bytes };
}

// ---------------------------------------------------------------------------
// Minimal typings of the GUN internals used here (gun.js, src/onto.js,
// src/mesh.js, lib/wire.js). The public typings do not describe them.
// ---------------------------------------------------------------------------

/** A listener link of GUN's `onto` event chains. */
interface OntoLink {
  next: (arg: unknown) => void;
  to: OntoLink;
  back: OntoLink | OntoTag;
  the: OntoTag;
}
interface OntoTag {
  tag: string;
  to: OntoLink;
  last: OntoLink | OntoTag;
}

interface PeerInternals {
  id?: string;
  url?: string;
  defer?: ReturnType<typeof setTimeout>;
  wire?: { readyState?: number; close?: () => void } | null;
}

interface WebSocketServerInternals {
  clients?: Set<{ terminate(): void }>;
  close(cb?: () => void): void;
}

interface RootInternals {
  graph: Record<string, Rec | undefined>;
  opt: {
    peers: Record<string, PeerInternals | undefined>;
    mesh?: { say(msg: Rec): unknown };
    ws?: { web?: WebSocketServerInternals };
  };
  on(tag: string): OntoLink | undefined;
  on(tag: string, fn: (this: OntoLink, msg: unknown) => void): OntoLink;
}

function rootOf(gun: IGunInstance): RootInternals {
  return (gun as unknown as { _: RootInternals })._;
}

/**
 * Registers `fn` as the FIRST listener of a root event chain, so it runs
 * before GUN's own `universe` handler (which would otherwise apply a put
 * before any later listener sees it). Same idea as gun/lib/afore.js, whose
 * relinking leaves the old tail pointing back at the head.
 */
function prependListener(root: RootInternals, tag: string, fn: (this: OntoLink, msg: unknown) => void): void {
  const first = root.on(tag);
  const link = root.on(tag, fn); // appended at the end
  if (!first || first === link) return;
  const head = first.the;
  // Unlink from the tail.
  const end = link.to;
  link.back.to = end;
  head.last = link.back;
  // Relink at the front.
  link.to = first;
  first.back = link;
  link.back = head;
  head.to = link;
}

// ---------------------------------------------------------------------------
// The filter
// ---------------------------------------------------------------------------

class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(private readonly rate: number, private readonly burst: number, now: number) {
    this.tokens = burst;
    this.last = now;
  }

  take(now: number): boolean {
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export interface RelayFilterOptions {
  limits?: Partial<RelayLimits>;
  /** Clock for the rate limiter (ms). */
  now?: () => number;
}

export interface RelayFilterStats {
  accepted: number;
  dropped: number;
  reasons: Record<string, number>;
}

export interface RelayFilter {
  readonly stats: RelayFilterStats;
}

/** The peer a message arrived from, or undefined for local (non-wire) messages. */
function wirePeerOf(msg: Rec): object | undefined {
  const meta = msg._;
  if (typeof meta !== 'function') return undefined;
  const via = (meta as { via?: unknown }).via;
  return typeof via === 'object' && via !== null ? via : undefined;
}

/**
 * Installs the relay's input filter (§8) as the first `in` middleware of
 * `gun`. Puts that arrive over the wire are dropped unless every node passes
 * `checkPut` and the connection is within its rate limit. Gets, acks and local
 * messages (disk reads, the relay's own replies) are not filtered.
 */
export function installRelayFilter(gun: IGunInstance, options: RelayFilterOptions = {}): RelayFilter {
  const limits: RelayLimits = { ...RELAY_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const buckets = new WeakMap<object, TokenBucket>();
  const stats: RelayFilterStats = { accepted: 0, dropped: 0, reasons: {} };
  const drop = (reason: string): void => {
    stats.dropped++;
    stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1;
  };

  prependListener(rootOf(gun), 'in', function relayFilter(this: OntoLink, msg: unknown): void {
    const m = typeof msg === 'object' && msg !== null ? (msg as Rec) : undefined;
    if (!m || m.put === undefined || m.put === null) {
      this.to.next(msg);
      return;
    }
    const peer = wirePeerOf(m);
    if (!peer) {
      this.to.next(msg);
      return;
    }
    let bucket = buckets.get(peer);
    if (!bucket) {
      bucket = new TokenBucket(limits.putsPerSecond, limits.burst, now());
      buckets.set(peer, bucket);
    }
    if (!bucket.take(now())) {
      drop('rate limit');
      return;
    }
    const verdict = checkPut(m.put, limits);
    if (!verdict.ok) {
      drop(verdict.reason);
      return;
    }
    stats.accepted++;
    this.to.next(msg);
  });

  return { stats };
}

// ---------------------------------------------------------------------------
// Relay construction
// ---------------------------------------------------------------------------

/** A `Gun` constructor (the process-wide one by default). */
export type GunFactory = (options: GunOptions) => IGunInstance;

/** GUN options of the relay (§8). */
export function relayOptions(web: Server, file: string): GunOptions {
  return {
    web,
    file,
    multicast: false,
    axe: false,
    localStorage: false,
    // lib/stats.js would otherwise write a stats file next to gun.js every 5 s.
    stats: false,
    ws: { maxPayload: RELAY_LIMITS.frameBytes },
  };
}

/** Creates the GUN relay on `web` (without the filter). */
export function createRelay(web: Server, file: string, GunCtor: GunFactory = defaultGun()): IGunInstance {
  return GunCtor(relayOptions(web, file));
}

function defaultGun(): GunFactory {
  return Gun as unknown as GunFactory;
}

// ---------------------------------------------------------------------------
// Boot self-test (§8)
// ---------------------------------------------------------------------------

export interface SelfTestOptions {
  /** The `Gun` to test; defaults to the process-wide one (the bundled code). */
  Gun?: GunFactory;
  /** Installs the filter for phase 2; defaults to `installRelayFilter`. */
  installFilter?: (gun: IGunInstance) => void;
  /** Parent of the temporary radisk directory; defaults to `os.tmpdir()`. */
  tmpRoot?: string;
  /** Wait after each batch of probes (ms). */
  settleMs?: number;
  /** Timeout of each wait for the network or the disk (ms). */
  probeTimeoutMs?: number;
}

export interface SelfTestReport {
  passed: string[];
  failures: string[];
}

type RadiskRead = (key: string, cb: (err: unknown, data: unknown) => void) => void;

/** The radisk instance lib/store.js opened on `file` (radisk caches them per file). */
function radiskFor(file: string): RadiskRead | undefined {
  const ns = radiskModule as unknown as { default?: unknown };
  const Radisk = (typeof ns.default === 'function' ? ns.default : radiskModule) as {
    has?: Record<string, RadiskRead | undefined>;
  };
  return Radisk.has?.[file];
}

const ESC = String.fromCharCode(27); // radisk soul/key separator (lib/store.js)

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function probeValue(): string {
  return VALUE_PREFIX + randomBytes(96).toString('base64url') + '.' + randomBytes(64).toString('base64url');
}

/** A fresh P-256 public key in SEA's `x.y` form. */
function freshPub(): string {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  return `${jwk.x}.${jwk.y}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`probe timeout: ${what}`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

async function waitConnected(root: RootInternals, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = Object.values(root.opt.peers).some((p) => p?.wire?.readyState === 1);
    if (open) return;
    if (Date.now() > deadline) throw new Error('probe timeout: loopback client did not connect');
    await sleep(20);
  }
}

/** Sends a raw put over the client's websocket, bypassing its local graph and SEA. */
function sendPut(client: RootInternals, soul: string, key: string, value: string): void {
  const mesh = client.opt.mesh;
  if (!mesh) throw new Error('loopback client has no mesh');
  mesh.say({
    '#': randomBytes(9).toString('base64url'),
    put: { [soul]: { _: { '#': soul, '>': { [key]: Gun.state() } }, [key]: value } },
  });
}

function closeClient(root: RootInternals): void {
  for (const [k, peer] of Object.entries(root.opt.peers)) {
    delete root.opt.peers[k]; // stops src/websocket.js from reconnecting
    if (!peer) continue;
    clearTimeout(peer.defer);
    try {
      peer.wire?.close?.();
    } catch {
      // already closed
    }
  }
}

function closeRelay(root: RootInternals, server: Server): Promise<void> {
  const wss = root.opt.ws?.web;
  for (const c of wss?.clients ?? []) c.terminate();
  wss?.close();
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Runs the §8 self-test cases against a throwaway relay built from `Gun` on
 * 127.0.0.1:0 with a temporary radisk directory, and reports every case.
 * Phase 1 (no filter) tests SEA; phase 2 installs the filter on the same relay.
 */
export async function runRelaySelfTest(options: SelfTestOptions = {}): Promise<SelfTestReport> {
  const GunCtor = options.Gun ?? defaultGun();
  const installFilter = options.installFilter ?? ((g: IGunInstance) => { installRelayFilter(g); });
  const settleMs = options.settleMs ?? 500;
  const probeTimeoutMs = options.probeTimeoutMs ?? 5000;
  const report: SelfTestReport = { passed: [], failures: [] };
  const check = (name: string, ok: boolean): void => {
    (ok ? report.passed : report.failures).push(name);
  };

  const sea = (GunCtor as unknown as { SEA?: unknown }).SEA;
  check('SEA is loaded (Gun.SEA exists)', typeof sea === 'object' && sea !== null);

  const tmpRoot = options.tmpRoot ?? tmpdir();
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(join(tmpRoot, 'avalon-relay-selftest-'));
  const file = join(dir, 'radata');
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });

  let relayRoot: RootInternals | undefined;
  let clientRoot: RootInternals | undefined;
  try {
    const port = await withTimeout(listen(server), probeTimeoutMs, 'listen');
    const relay = GunCtor(relayOptions(server, file));
    const relayR = rootOf(relay);
    relayRoot = relayR;
    const client = GunCtor({
      peers: [`http://127.0.0.1:${port}/gun`],
      // lib/server.js defaults `super` to true for every instance in node; a
      // super peer never dials out, so the loopback client must not be one.
      super: false,
      localStorage: false,
      radisk: false,
      rfs: false,
      multicast: false,
      axe: false,
      stats: false,
    });
    const clientR = rootOf(client);
    clientRoot = clientR;
    await waitConnected(clientR, probeTimeoutMs);

    const readDisk = (soul: string, key: string): Promise<unknown> => {
      const rad = radiskFor(file);
      if (!rad) return Promise.reject(new Error('radisk store of the relay not found'));
      return withTimeout(new Promise<unknown>((resolve) => {
        rad(soul + ESC + key, (_err, data) => resolve(isRecord(data) ? data[':'] : undefined));
      }), probeTimeoutMs, `radisk read ${soul}`);
    };
    const inGraph = (soul: string, key: string): unknown => relayR.graph[soul]?.[key];
    const storedAs = async (soul: string, key: string, value: string): Promise<boolean> =>
      inGraph(soul, key) === value && (await readDisk(soul, key)) === value;
    const absent = async (soul: string, key: string): Promise<boolean> =>
      inGraph(soul, key) === undefined && (await readDisk(soul, key)) === undefined;

    const lobbySoul = 'avalon/v1/lobby/ZZZZ#';

    // Phase 1: SEA, without the filter.
    const aValue = probeValue();
    const aKey = sha256Hex(aValue + 'x'); // well-formed value under a wrong key
    sendPut(clientR, lobbySoul, aKey, aValue);

    const userSoul = '~' + freshPub();
    const bValue = JSON.stringify({ ':': 'selftest', '~': randomBytes(64).toString('base64') });
    sendPut(clientR, userSoul, PRESENCE_KEY, bValue);

    const cValue = probeValue();
    const cKey = sha256Hex(cValue);
    sendPut(clientR, lobbySoul, cKey, cValue);

    await sleep(settleMs);
    check('(a) value under a wrong hash key is rejected', await absent(lobbySoul, aKey));
    check('(b) presence value with a bad signature is rejected', await absent(userSoul, PRESENCE_KEY));
    check('(c) valid lobby value is stored', await storedAs(lobbySoul, cKey, cValue));

    sendPut(clientR, lobbySoul, cKey, probeValue());
    await sleep(settleMs);
    check('(c) overwrite of a stored value is rejected', await storedAs(lobbySoul, cKey, cValue));

    // Phase 2: the filter, on the same instance.
    installFilter(relay);
    const selftestSoul = 'avalon/v1/selftest#';
    const dValue = probeValue();
    const dKey = sha256Hex(dValue);
    sendPut(clientR, selftestSoul, dKey, dValue);
    const eValue = probeValue();
    const eKey = sha256Hex(eValue);
    sendPut(clientR, lobbySoul, eKey, eValue);

    await sleep(settleMs);
    check('(filter) correctly hashed value under a non-whitelisted soul is rejected', await absent(selftestSoul, dKey));
    check('(filter) valid lobby value is stored', await storedAs(lobbySoul, eKey, eValue));
  } catch (err) {
    report.failures.push(err instanceof Error ? err.message : String(err));
  } finally {
    if (clientRoot) closeClient(clientRoot);
    if (relayRoot) await closeRelay(relayRoot, server);
    else if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
  return report;
}

/**
 * The boot self-test of §8. Resolves when every case passed; rejects with the
 * list of failed cases otherwise (the entry point then exits with status 1).
 */
export async function relaySelfTest(options: SelfTestOptions = {}): Promise<void> {
  const report = await runRelaySelfTest(options);
  if (report.failures.length > 0) {
    throw new Error(`relay self-test failed: ${report.failures.join('; ')}`);
  }
}
