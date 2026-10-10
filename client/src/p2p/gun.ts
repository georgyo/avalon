/**
 * The GUN instance (docs/p2p-protocol.md §7.1), clock drift (§7.2) and
 * relay-info polling.
 *
 * Content-addressed puts need no GUN user session; only presence writes to
 * user space, after `auth(pair)` resolved. GUN's localStorage adapter and
 * radisk are off: all app state is in IndexedDB (§3.9).
 *
 * The public typings of `gun` describe the chain API loosely; this module
 * declares the small part of the API and of the root internals it uses
 * (`opt.peers`, `opt.mesh.say`, the `hi`/`bye`/`in` hooks) and casts once.
 */
import Gun from 'gun';
import 'gun/sea';
import { Listeners } from './env.ts';

// ---------------------------------------------------------------- GUN typings (the subset used)

export interface GunAck { ok?: unknown; err?: string; lack?: boolean }

export interface GunChain {
  get(key: string): GunChain;
  put(value: string, cb?: (ack: GunAck) => void): GunChain;
  map(): GunChain;
  on(cb: (data: unknown, key: string) => void): GunChain;
}

export interface SeaPair { pub: string; priv: string; epub: string; epriv: string }

export interface GunUserChain extends GunChain {
  auth(pair: SeaPair, cb: (ack: { err?: string }) => void): void;
  leave(): void;
}

export interface GunWire { readyState?: number; close?(): void }

export interface GunPeer { id?: string; url?: string; wire?: GunWire | null; defer?: unknown }

export type GunMessage = Record<string, unknown>;

/** The `this` of a GUN event listener: pass the event on with `this.to.next(x)`. */
export interface OntoLink { to: { next(arg: unknown): void } }

export interface GunRoot {
  opt: {
    peers: Record<string, GunPeer | undefined>;
    mesh?: { say(msg: GunMessage, peer?: GunPeer): unknown };
  };
  graph: Record<string, Record<string, unknown> | undefined>;
  on(event: string, cb: (this: OntoLink, arg: unknown) => void): void;
}

export interface GunInstance extends GunChain {
  user(): GunUserChain;
  opt(o: Record<string, unknown>): void;
  _: GunRoot;
}

export type GunFactory = (options: Record<string, unknown>) => GunInstance;

interface GunStatic {
  state: { drift: number };
  log: { off?: boolean };
}

const GunCtor = Gun as unknown as GunFactory & GunStatic;

/** GUN's wire state of the websocket: OPEN. */
const WS_OPEN = 1;

// ---------------------------------------------------------------- relay info and clock (§7.2)

export interface RelayInfo {
  bootId: string;
  now: number;
  /** Public relays the relay advertises (§7.1); validated, possibly empty. */
  peers: string[];
}

export type FetchLike = (url: string, init?: { cache?: 'no-store' }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

function isRelayInfo(v: unknown): v is Omit<RelayInfo, 'peers'> & { peers?: unknown } {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.bootId === 'string' && typeof r.now === 'number' && Number.isFinite(r.now);
}

/** At most this many public relays are dialed. */
export const MAX_PUBLIC_PEERS = 8;

/** Loopback hosts may use plain http/ws (development and tests). */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A relay URL this client may dial (same rule as server/peers.ts): https/wss,
 * http/ws only on loopback, no credentials, query or fragment.
 */
export function isPeerUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 200) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const secure = u.protocol === 'https:' || u.protocol === 'wss:';
  const plain = u.protocol === 'http:' || u.protocol === 'ws:';
  if (!secure && !(plain && LOOPBACK.has(u.hostname))) return false;
  return u.username === '' && u.password === '' && u.search === '' && u.hash === '';
}

/** The valid, distinct relay URLs of an untrusted list, at most MAX_PUBLIC_PEERS. */
export function sanitizePeers(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const url of list) {
    if (isPeerUrl(url) && !out.includes(url)) out.push(url);
    if (out.length === MAX_PUBLIC_PEERS) break;
  }
  return out;
}

/** Base URL ("https://host") without a trailing slash. */
export function normalizeBase(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * `GET /api/relay-info` → `{ bootId, now }`, plus the round-trip time.
 * `relayUrl` is the page origin (or the relay's base URL).
 */
export async function relayInfo(relayUrl?: string, fetchFn?: FetchLike): Promise<RelayInfo & { rtt: number }> {
  const f: FetchLike = fetchFn ?? ((url, init) => fetch(url, init));
  const base = normalizeBase(relayUrl ?? (typeof location !== 'undefined' ? location.origin : ''));
  const t0 = Date.now();
  const res = await f(base + '/api/relay-info', { cache: 'no-store' });
  if (!res.ok) throw new Error('relay-info: HTTP error');
  const body = await res.json();
  const rtt = Date.now() - t0;
  if (!isRelayInfo(body)) throw new Error('relay-info: malformed response');
  return { bootId: body.bootId, now: body.now, peers: sanitizePeers(body.peers), rtt };
}

/**
 * The drift-corrected wall clock (§7.2): `drift = now + rtt/2 − Date.now()`,
 * also installed as `Gun.state.drift` so GUN's HAM states are not in the
 * relay's future. Envelope `t` values use `now()`. No protocol decision uses it.
 */
export class Clock {
  private driftMs = 0;

  constructor(private readonly applyToGun = true) {}

  get drift(): number {
    return this.driftMs;
  }

  sync(info: { now: number; rtt: number }): void {
    this.driftMs = Math.round(info.now + info.rtt / 2 - Date.now());
    if (this.applyToGun) GunCtor.state.drift = this.driftMs;
  }

  now(): number {
    return Date.now() + this.driftMs;
  }
}

// ---------------------------------------------------------------- the GUN handle

export interface PeerStatus {
  url: string;
  /** This app's own relay (`<relay>/gun`), as opposed to a public relay. */
  own: boolean;
  open: boolean;
}

export interface GunHandle {
  readonly gun: GunInstance;
  readonly root: GunRoot;
  /** The websocket peer URL of the own relay (`<relay>/gun`). */
  readonly peerUrl: string;
  /** True while at least one relay (own or public) has an open websocket. */
  connected(): boolean;
  /** Adds public relays to dial in addition to the own relay (§7.1). */
  addPeers(urls: readonly string[]): void;
  /** Every relay this handle dials, with its state. */
  peers(): PeerStatus[];
  /**
   * Redials the relays whose websocket is closed while another one is open,
   * each with its own backoff (own relay: 2, 4, 8, then 15 s; public relays:
   * 30 s doubling up to 10 min). Cheap to call often.
   */
  redialMissing(): void;
  onHi(cb: () => void): () => void;
  onBye(cb: () => void): () => void;
  /** Every incoming wire/local message (before SEA), for reply tracking. */
  onIn(cb: (msg: GunMessage) => void): () => void;
  /** Re-adds every relay peer without an open websocket (GUN drops a peer after one failed retry) and dials it (§7.4). */
  reconnect(): void;
  /** Sends a raw message to every peer. */
  say(msg: GunMessage): void;
  /** Re-asks a soul from the relay, bypassing GUN's local cache (§7.3). Returns the message id. */
  reask(soul: string): string;
  /** Authenticates the GUN user (presence writes, §7.6). Memoized per pair. */
  auth(pair: SeaPair): Promise<void>;
  readonly authed: boolean;
  close(): void;
}

export interface CreateGunOptions {
  /** Public relays to dial too (§7.1). */
  extraPeers?: readonly string[];
  /** Clock for the redial backoff (tests). */
  now?: () => number;
  /** Extra GUN options (tests). */
  gunOptions?: Record<string, unknown>;
  /** Alternative factory (tests). */
  factory?: GunFactory;
}

let msgCounter = 0;

function randomId(): string {
  msgCounter = (msgCounter + 1) % 1e9;
  return 'av' + Math.random().toString(36).slice(2, 10) + msgCounter.toString(36);
}

/** Redial backoff of the own relay while a public relay is open: 2, 4, 8, then 15 s (§7.4). */
const OWN_REDIAL_MS = [2000, 4000, 8000, 15000];
/** Redial backoff of a public relay: 30 s doubling up to 10 min. */
const PUBLIC_REDIAL_FIRST_MS = 30000;
const PUBLIC_REDIAL_MAX_MS = 10 * 60 * 1000;

interface DialState { own: boolean; attempt: number; nextAt: number }

/**
 * Creates a GUN instance connected to `<relayUrl>/gun` and to the public relays
 * of `extraPeers` (§7.1). Every put and get goes to every open relay; a client
 * connected to several relays also forwards what one sends it to the others,
 * which keeps them in sync. The node-only options keep a node client from
 * becoming a super peer (lib/server.js makes every node instance one, and super
 * peers never dial out); in a browser they are the defaults.
 */
export function createGun(relayUrl: string, o: CreateGunOptions = {}): GunHandle {
  const peerUrl = normalizeBase(relayUrl) + '/gun';
  const factory = o.factory ?? GunCtor;
  const now = o.now ?? Date.now;
  const dial = new Map<string, DialState>([[peerUrl, { own: true, attempt: 0, nextAt: 0 }]]);
  for (const url of sanitizePeers(o.extraPeers ?? [])) {
    if (!dial.has(url)) dial.set(url, { own: false, attempt: 0, nextAt: 0 });
  }
  const gun = factory({
    peers: [...dial.keys()],
    localStorage: false,
    radisk: false,
    super: false,
    rfs: false,
    multicast: false,
    axe: false,
    stats: false,
    ...o.gunOptions,
  });
  const root = gun._;
  const hi = new Listeners<void>();
  const bye = new Listeners<void>();
  const inbound = new Listeners<GunMessage>();
  let closed = false;
  let authPromise: Promise<void> | null = null;
  let authPub: string | null = null;
  let authed = false;

  root.on('hi', function (this: OntoLink, peer: unknown) {
    this.to.next(peer);
    const url = typeof peer === 'object' && peer !== null ? (peer as GunPeer).url : undefined;
    const st = url === undefined ? undefined : dial.get(url);
    if (st !== undefined) st.attempt = 0;
    if (!closed) hi.emit();
  });
  root.on('bye', function (this: OntoLink, peer: unknown) {
    this.to.next(peer);
    if (!closed) bye.emit();
  });
  root.on('in', function (this: OntoLink, msg: unknown) {
    if (!closed && typeof msg === 'object' && msg !== null && inbound.size > 0) inbound.emit(msg as GunMessage);
    this.to.next(msg);
  });

  const say = (msg: GunMessage): void => {
    const mesh = root.opt.mesh;
    if (closed || mesh === undefined) return;
    mesh.say(msg);
  };

  const isOpen = (url: string): boolean => root.opt.peers[url]?.wire?.readyState === WS_OPEN;

  /** Prepares a relay without an open or opening websocket for dialing; false if it needs none. */
  const rearm = (url: string): boolean => {
    const peer = root.opt.peers[url];
    // A peer whose socket is still opening is left alone.
    const wire = peer?.wire;
    if (wire !== undefined && wire !== null && wire.readyState !== undefined && wire.readyState <= WS_OPEN) return false;
    // A closed wire left on the peer would make gun queue messages instead of dialing.
    if (peer !== undefined && wire !== undefined && wire !== null) peer.wire = null;
    gun.opt({ peers: [url] });
    return true;
  };

  /** Any outgoing message dials the peers without a wire (gun.js mesh.say → mesh.wire). */
  const dialArmed = (armed: boolean): void => {
    if (armed) say({ dam: 'hi' });
  };

  const handle: GunHandle = {
    gun,
    root,
    peerUrl,
    connected: () => !closed && Object.values(root.opt.peers).some((p) => p?.wire?.readyState === WS_OPEN),
    addPeers: (urls) => {
      if (closed) return;
      let armed = false;
      for (const url of sanitizePeers(urls)) {
        if (dial.has(url) || dial.size > MAX_PUBLIC_PEERS) continue;
        dial.set(url, { own: false, attempt: 0, nextAt: 0 });
        armed = rearm(url) || armed;
      }
      dialArmed(armed);
    },
    peers: () => [...dial].map(([url, st]) => ({ url, own: st.own, open: !closed && isOpen(url) })),
    redialMissing: () => {
      if (closed || !handle.connected()) return;
      const t = now();
      let armed = false;
      for (const [url, st] of dial) {
        if (isOpen(url) || t < st.nextAt) continue;
        const wait = st.own
          ? OWN_REDIAL_MS[Math.min(st.attempt, OWN_REDIAL_MS.length - 1)]
          : Math.min(PUBLIC_REDIAL_FIRST_MS * 2 ** Math.min(st.attempt, 10), PUBLIC_REDIAL_MAX_MS);
        // The first redial waits a full step: GUN itself retries a dropped socket once.
        if (st.nextAt === 0) {
          st.nextAt = t + wait;
          continue;
        }
        st.attempt++;
        st.nextAt = t + wait;
        armed = rearm(url) || armed;
      }
      dialArmed(armed);
    },
    onHi: (cb) => hi.add(cb),
    onBye: (cb) => bye.add(cb),
    onIn: (cb) => inbound.add(cb),
    reconnect: () => {
      if (closed) return;
      let armed = false;
      for (const url of dial.keys()) armed = rearm(url) || armed;
      dialArmed(armed);
    },
    say,
    reask: (soul) => {
      const id = randomId();
      say({ '#': id, get: { '#': soul } });
      return id;
    },
    auth: (pair) => {
      if (authPromise !== null && authPub === pair.pub) return authPromise;
      authPub = pair.pub;
      authed = false;
      const p = new Promise<void>((resolve, reject) => {
        gun.user().auth(pair, (ack) => {
          if (ack.err !== undefined) {
            reject(new Error(ack.err));
            return;
          }
          authed = true;
          resolve();
        });
      });
      authPromise = p;
      p.catch(() => {
        if (authPromise === p) authPromise = null;
      });
      return p;
    },
    get authed() {
      return authed;
    },
    close: () => {
      if (closed) return;
      closed = true;
      for (const [k, peer] of Object.entries(root.opt.peers)) {
        delete root.opt.peers[k]; // stops gun's websocket adapter from reconnecting
        if (peer === undefined) continue;
        if (peer.defer !== undefined) clearTimeout(peer.defer as Parameters<typeof clearTimeout>[0]);
        try {
          peer.wire?.close?.();
        } catch {
          // already closed
        }
      }
    },
  };
  return handle;
}

/** Silences GUN's console logging (tests). */
export function silenceGunLog(off = true): void {
  GunCtor.log.off = off;
}
