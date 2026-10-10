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
  /** Values accepted per public soul (per process lifetime; re-puts of a stored key do not count). */
  soulValues: { lobby: number; game: number; logs: number };
  /** Bytes accepted per public soul (same accounting). */
  soulBytes: { lobby: number; game: number; logs: number };
  /** Sustained gets per second per connection, and their burst. */
  getsPerSecond: number;
  getBurst: number;
  /** Souls whose puts are forwarded to one connection (its gets); further gets are dropped. */
  subscriptionsPerConnection: number;
  /** Per client IP (public addresses only, see RelayFilterOptions.ipOf): connections, puts and gets. */
  connectionsPerIp: number;
  putsPerSecondPerIp: number;
  putBurstPerIp: number;
  getsPerSecondPerIp: number;
  getBurstPerIp: number;
  /** Maximum UTF-8 size of the SEA-signed presence value. */
  presenceBytes: number;
  /** Maximum size of the put payload of one GUN message (souls + keys + values). */
  messageBytes: number;
  /**
   * Puts per second per connection before validation (and their burst). This
   * only bounds the hashing work; invalid puts (junk forwarded from a public
   * relay by a client connected to both, §8) are charged here and never
   * against `putsPerSecond`, so they cannot starve the client's own valid puts.
   */
  ingressPerSecond: number;
  ingressBurst: number;
  /** Sustained valid puts per second per connection. */
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
  soulValues: Object.freeze({ lobby: 4096, game: 4096, logs: 200000 }),
  soulBytes: Object.freeze({ lobby: 16 * 1024 * 1024, game: 32 * 1024 * 1024, logs: 1024 * 1024 * 1024 }),
  getsPerSecond: 20,
  getBurst: 200,
  subscriptionsPerConnection: 1024,
  connectionsPerIp: 32,
  putsPerSecondPerIp: 200,
  putBurstPerIp: 1000,
  getsPerSecondPerIp: 60,
  getBurstPerIp: 600,
  presenceBytes: 1024,
  messageBytes: 256 * 1024,
  ingressPerSecond: 500,
  ingressBurst: 2000,
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
/** An envelope value: `AV1.` ‖ b64url(canonical JSON) ‖ `.` ‖ b64url(64-byte signature) (§3.3). */
export const VALUE_RE = /^AV1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/;

/** Message types per public soul kind (docs/p2p-protocol.md §3.1-3.2; common/protocol/types.ts). */
const SOUL_TYPES = {
  lobby: ['lobby.create', 'lobby.join', 'lobby.leave', 'lobby.roster', 'lobby.config'],
  setup: ['key', 'shuffle', 'deal', 'ot.recv', 'ot.send'],
  play: ['propose', 'vote.commit', 'vote.reveal', 'ballot', 'tally', 'assassinate', 'cancel', 'reveal'],
  logs: ['log'],
} as const;

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
  // Exactly ':' and '~': SEA verifies a value carrying '*' against that embedded pub instead of the
  // soul's owner (and skips the certificate check without '+'), so any key pair could write it.
  if (!isRecord(parsed)) return false;
  const keys = Object.keys(parsed).sort();
  return keys.length === 2 && keys[0] === ':' && keys[1] === '~'
    && typeof parsed['~'] === 'string'
    && parsed['~'].length > 0;
}

/** The kind of a public soul, and its game id / lobby code. */
function publicSoulKind(soul: string): { kind: 'lobby'; code: string } | { kind: 'setup' | 'play'; gameId: string } | { kind: 'logs' } | null {
  let m = /^avalon\/v1\/lobby\/([A-HJ-NP-TV-Z]{4})#$/.exec(soul);
  if (m !== null) return { kind: 'lobby', code: m[1] };
  m = /^avalon\/v1\/game\/([A-Za-z0-9_-]{22})\/(setup|play)#$/.exec(soul);
  if (m !== null) return { kind: m[2] === 'setup' ? 'setup' : 'play', gameId: m[1] };
  if (/^avalon\/v1\/logs\/\d{4}-\d{2}#$/.test(soul)) return { kind: 'logs' };
  return null;
}

/**
 * Cheap structural check of an envelope value for `soul` (no signature check, which clients do):
 * the `AV1.<b64url>.<sig>` shape, a JSON object whose `type` belongs to the soul and whose `game`
 * (game souls) or `body.code` (lobby.create) matches it.
 */
export function checkEnvelopeShape(soul: string, value: string): string | null {
  if (!VALUE_RE.test(value)) return 'value is not an AV1 envelope';
  const where = publicSoulKind(soul);
  if (where === null) return 'soul not whitelisted';
  let env: unknown;
  try {
    env = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return 'envelope is not JSON';
  }
  if (!isRecord(env) || typeof env.type !== 'string') return 'envelope has no type';
  if (!(SOUL_TYPES[where.kind] as readonly string[]).includes(env.type)) return 'message type does not belong to the soul';
  if ((where.kind === 'setup' || where.kind === 'play') && env.game !== where.gameId) return 'game does not match the soul';
  if (where.kind === 'lobby' && env.type === 'lobby.create' && (!isRecord(env.body) || env.body.code !== where.code)) {
    return 'lobby code does not match the soul';
  }
  return null;
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
      const shape = checkEnvelopeShape(soul, value);
      if (shape !== null) return { ok: false, reason: shape };
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

export interface PeerInternals {
  id?: string;
  url?: string;
  defer?: ReturnType<typeof setTimeout>;
  wire?: {
    readyState?: number;
    close?: () => void;
    headers?: Record<string, string | string[] | undefined>;
    _socket?: { remoteAddress?: string };
  } | null;
}

/** GUN's mesh (src/mesh.js), as far as the relay patches it. */
interface MeshInternals {
  say(msg: unknown, peer?: PeerInternals): unknown;
  hear: ((raw: unknown, peer: unknown) => unknown) & {
    one(msg: unknown, peer: unknown, S: unknown): unknown;
    mob?: (msg: unknown, peer: unknown) => unknown;
  };
  hardened?: boolean;
  routed?: boolean;
}

interface WebSocketServerInternals {
  clients?: Set<{ terminate(): void }>;
  close(cb?: () => void): void;
}

interface RootInternals {
  graph: Record<string, Rec | undefined>;
  opt: {
    peers: Record<string, PeerInternals | undefined>;
    mesh?: MeshInternals;
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
  /** Clock for the rate limiters (ms). */
  now?: () => number;
  /**
   * The client address of a connection, for the per-IP limits; null exempts it. Default: the
   * socket's remote address, or with `trustProxy` the last `X-Forwarded-For` entry; loopback and
   * private addresses are exempt (behind an unconfigured reverse proxy every client would share one).
   */
  ipOf?: (peer: PeerInternals) => string | null;
  /** Take the client address from the last `X-Forwarded-For` entry (the relay sits behind a proxy). */
  trustProxy?: boolean;
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
function wirePeerOf(msg: Rec): PeerInternals | undefined {
  const meta = msg._;
  if (typeof meta !== 'function') return undefined;
  const via = (meta as { via?: unknown }).via;
  return typeof via === 'object' && via !== null ? (via as PeerInternals) : undefined;
}

function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return v4 === '::1' || /^127\./.test(v4) || /^10\./.test(v4) || /^192\.168\./.test(v4)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(v4) || /^169\.254\./.test(v4) || /^f[cd][0-9a-f]{2}:/i.test(v4) || /^fe80:/i.test(v4);
}

/** Default client address of a connection (see RelayFilterOptions.ipOf). */
export function defaultIpOf(peer: PeerInternals, trustProxy = false): string | null {
  const wire = peer.wire;
  if (!wire) return null;
  let ip: string | undefined;
  if (trustProxy) {
    const xff = wire.headers?.['x-forwarded-for'];
    const list = (Array.isArray(xff) ? xff.join(',') : xff ?? '').split(',').map((x) => x.trim()).filter((x) => x !== '');
    ip = list[list.length - 1];
  }
  ip ??= wire._socket?.remoteAddress;
  if (ip === undefined || ip === '' || isPrivateAddress(ip)) return null;
  return ip;
}

/**
 * Hardens GUN's mesh on the relay (§8): the wire may only use the `?` (handshake) and `!` (error)
 * DAM messages. GUN's built-in `mob` handler would otherwise dial any URL a client names (SSRF,
 * outbound socket exhaustion), and DAM names are looked up on a function object (`call`, `bind`...).
 */
export function hardenMesh(gun: IGunInstance): void {
  const mesh = rootOf(gun).opt.mesh;
  if (!mesh || mesh.hardened === true) return;
  mesh.hardened = true;
  mesh.hear.mob = () => undefined;
  const one = mesh.hear.one;
  mesh.hear.one = function (this: unknown, msg: unknown, peer: unknown, S: unknown): unknown {
    if (isRecord(msg) && msg.dam !== undefined && msg.dam !== '?' && msg.dam !== '!') return undefined;
    return one.call(this, msg, peer, S);
  };
}

/**
 * Installs the relay's input filter (§8) as the first `in` middleware of
 * `gun`, and its output routing. Puts that arrive over the wire are dropped
 * unless every node passes `checkPut`, the connection and its IP are within
 * their rate limits and the soul within its quota; acknowledgements and replies
 * (`@`) from clients are dropped (any client could forge one for another
 * client's put or get); gets are rate limited. Forwarded puts go only to the
 * connections that asked for the soul (a get), and gets are never forwarded to
 * clients, so a passive listener learns no lobby code, game or presence it did
 * not ask for. Local messages (disk reads, the relay's own replies) are not
 * filtered.
 */
export function installRelayFilter(gun: IGunInstance, options: RelayFilterOptions = {}): RelayFilter {
  const limits: RelayLimits = { ...RELAY_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const ipOf = options.ipOf ?? ((peer: PeerInternals) => defaultIpOf(peer, options.trustProxy === true));
  const root = rootOf(gun);
  const putBuckets = new WeakMap<object, TokenBucket>();
  const ingressBuckets = new WeakMap<object, TokenBucket>();
  const getBuckets = new WeakMap<object, TokenBucket>();
  const ipPutBuckets = new Map<string, TokenBucket>();
  const ipGetBuckets = new Map<string, TokenBucket>();
  const ipConnections = new Map<string, number>();
  const peerIp = new WeakMap<object, string | null>();
  const subscribed = new WeakMap<object, Set<string>>();
  const quota = new Map<string, { values: number; bytes: number }>();
  const stats: RelayFilterStats = { accepted: 0, dropped: 0, reasons: {} };
  const drop = (reason: string): void => {
    stats.dropped++;
    stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1;
  };
  const bucketOf = (map: WeakMap<object, TokenBucket> | Map<string, TokenBucket>, k: object | string, rate: number, burst: number): TokenBucket => {
    let b = (map as Map<object | string, TokenBucket>).get(k);
    if (!b) {
      b = new TokenBucket(rate, burst, now());
      (map as Map<object | string, TokenBucket>).set(k, b);
    }
    return b;
  };
  const ipFor = (peer: PeerInternals): string | null => {
    if (!peerIp.has(peer)) peerIp.set(peer, ipOf(peer));
    return peerIp.get(peer) ?? null;
  };

  hardenMesh(gun);

  // Connections per IP.
  root.on('hi', function (this: OntoLink, arg: unknown): void {
    this.to.next(arg);
    const peer = arg as PeerInternals;
    const ip = ipFor(peer);
    if (ip === null) return;
    const n = (ipConnections.get(ip) ?? 0) + 1;
    ipConnections.set(ip, n);
    if (n > limits.connectionsPerIp) {
      drop('too many connections from one address');
      try {
        peer.wire?.close?.();
      } catch {
        // already closed
      }
    }
  });
  root.on('bye', function (this: OntoLink, arg: unknown): void {
    this.to.next(arg);
    const ip = ipFor(arg as PeerInternals);
    if (ip === null) return;
    const n = (ipConnections.get(ip) ?? 1) - 1;
    if (n <= 0) {
      ipConnections.delete(ip);
      ipPutBuckets.delete(ip);
      ipGetBuckets.delete(ip);
    } else {
      ipConnections.set(ip, n);
    }
  });

  prependListener(root, 'in', function relayFilter(this: OntoLink, msg: unknown): void {
    const m = typeof msg === 'object' && msg !== null ? (msg as Rec) : undefined;
    const peer = m ? wirePeerOf(m) : undefined;
    if (!m || !peer) {
      this.to.next(msg);
      return;
    }
    if (m['@'] !== undefined) {
      drop('ack from a client');
      return;
    }
    const ip = ipFor(peer);
    if (m.get !== undefined && m.get !== null) {
      if (!bucketOf(getBuckets, peer, limits.getsPerSecond, limits.getBurst).take(now())
          || (ip !== null && !bucketOf(ipGetBuckets, ip, limits.getsPerSecondPerIp, limits.getBurstPerIp).take(now()))) {
        drop('get rate limit');
        return;
      }
      const soul = isRecord(m.get) ? m.get['#'] : undefined;
      if (typeof soul === 'string') {
        let set = subscribed.get(peer);
        if (!set) subscribed.set(peer, (set = new Set()));
        if (!set.has(soul)) {
          if (set.size >= limits.subscriptionsPerConnection) {
            drop('too many subscriptions');
            return;
          }
          set.add(soul);
        }
      }
      this.to.next(msg);
      return;
    }
    if (m.put === undefined || m.put === null) {
      this.to.next(msg);
      return;
    }
    if (!bucketOf(ingressBuckets, peer, limits.ingressPerSecond, limits.ingressBurst).take(now())) {
      drop('ingress rate limit');
      return;
    }
    // Validate before charging the put limits: a client connected to a public
    // relay too forwards whatever that relay sends it, junk included (§8).
    const verdict = checkPut(m.put, limits);
    if (!verdict.ok) {
      drop(verdict.reason);
      return;
    }
    if (!bucketOf(putBuckets, peer, limits.putsPerSecond, limits.burst).take(now())
        || (ip !== null && !bucketOf(ipPutBuckets, ip, limits.putsPerSecondPerIp, limits.putBurstPerIp).take(now()))) {
      drop('rate limit');
      return;
    }
    // Per-soul quotas, for values the relay does not hold yet.
    const put = m.put as Rec;
    const fresh: { soul: string; bytes: number }[] = [];
    for (const soul of Object.keys(put)) {
      const where = publicSoulKind(soul);
      if (where === null) continue;
      const node = put[soul] as Rec;
      for (const key of Object.keys(node)) {
        if (key === '_' || root.graph[soul]?.[key] !== undefined) continue;
        fresh.push({ soul, bytes: utf8Bytes(String(node[key])) });
      }
    }
    for (const f of fresh) {
      const where = publicSoulKind(f.soul);
      const kind = where === null ? 'lobby' : where.kind === 'setup' || where.kind === 'play' ? 'game' : where.kind;
      const q = quota.get(f.soul) ?? { values: 0, bytes: 0 };
      if (q.values + 1 > limits.soulValues[kind] || q.bytes + f.bytes > limits.soulBytes[kind]) {
        drop('soul quota exceeded');
        return;
      }
    }
    for (const f of fresh) {
      const q = quota.get(f.soul) ?? { values: 0, bytes: 0 };
      q.values++;
      q.bytes += f.bytes;
      quota.set(f.soul, q);
    }
    stats.accepted++;
    this.to.next(msg);
  });

  // Output routing: forwarded puts only to the connections that asked for the soul; no gets to clients.
  const mesh = root.opt.mesh;
  if (mesh && mesh.routed !== true) {
    mesh.routed = true;
    const say = mesh.say;
    mesh.say = function (this: unknown, msg: unknown, peer?: PeerInternals): unknown {
      if (peer !== undefined && peer !== null && isRecord(msg) && msg.dam === undefined && msg['@'] === undefined) {
        if (msg.get !== undefined) return false;
        if (isRecord(msg.put)) {
          const set = subscribed.get(peer);
          if (!set || !Object.keys(msg.put).some((soul) => set.has(soul))) return false;
        }
      }
      return say.call(this, msg, peer);
    };
  }

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

/** A well-shaped (unsigned) lobby envelope value: the filter checks shapes, clients check signatures. */
function probeValue(): string {
  const env = { v: 1, type: 'lobby.join', lobby: randomBytes(32).toString('hex'), nonce: randomBytes(24).toString('base64url') };
  return VALUE_PREFIX + Buffer.from(JSON.stringify(env)).toString('base64url') + '.' + randomBytes(64).toString('base64url');
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

    // A presence value naming another signer in '*' (SEA's certificate path) is refused by shape.
    const fSoul = '~' + freshPub();
    sendPut(clientR, fSoul, PRESENCE_KEY, JSON.stringify({ ':': 'selftest', '~': randomBytes(64).toString('base64'), '*': freshPub() }));
    // A well-hashed value that is no envelope of this soul's kind.
    const gValue = VALUE_PREFIX + randomBytes(96).toString('base64url') + '.' + randomBytes(64).toString('base64url');
    const gKey = sha256Hex(gValue);
    sendPut(clientR, lobbySoul, gKey, gValue);

    await sleep(settleMs);
    check('(filter) correctly hashed value under a non-whitelisted soul is rejected', await absent(selftestSoul, dKey));
    check('(filter) valid lobby value is stored', await storedAs(lobbySoul, eKey, eValue));
    check('(filter) presence value carrying "*" is rejected', await absent(fSoul, PRESENCE_KEY));
    check('(filter) value that is not a lobby envelope is rejected', await absent(lobbySoul, gKey));
    check('(filter) the mesh accepts no DAM but "?" and "!"', relayR.opt.mesh?.hardened === true);
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
