/**
 * Lobby reducer (docs/p2p-protocol.md §4): a pure, order-independent function of
 * the set of lobby messages. The admin's signed roster chain is the only
 * authority for membership, names, seat order and kicks.
 *
 * Deviation from the §3.2 table (documented in the WP-B report): `lobby.leave`
 * carries `prev` = the joinId of the membership it ends (the creator's joinId is
 * the lobbyId), or of the pending join request it withdraws. Without that anchor
 * an old leave would also apply to a later membership of the same pub, so a
 * player who left could never rejoin a lobby from the same device.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { b64uDecode, b64uEncode, concat, hexDecode, hexEncode, sha256, utf8 } from '../crypto/bytes.ts';
import type { B64, Hex32, Pub } from '../crypto/types.ts';
import type { Signer } from './envelope.ts';
import { MAX_PLAYERS, MIN_PLAYERS, RULES_HASH, validateName, validateSelectedRoles } from './rules.ts';
import type { Bodies, Envelope, GameConfig, Member, RejectReason, StoredMsg } from './types.ts';

export interface LobbyCandidate {
  lobbyId: Hex32; code: string; adminPub: Pub; adminName: string; members: string[]; fingerprint: string;
  /** Fingerprint of the admin's public key (§4.1): grinding it means grinding P-256 key pairs. */
  adminFingerprint: string;
}

/** Joins rejected per roster at most (a roster lists at most 256 rejections, §3.2), oldest first. */
export const MAX_REJECTIONS_PER_ROSTER = 32;
/** How long an honest seat waits after receiving a takeover roster before keying a config based on it (§4.5). */
export const TAKEOVER_SETTLE_MS = 60000;
export const INVITE_KEY_BYTES = 16;
const INVITE_TAG = utf8('avalon-p2p/v1/invite\0');
const TICKET_TAG = utf8('avalon-p2p/v1/ticket\0');

export interface ChainNode {
  rosterId: Hex32;           // the lobbyId for the root (seq 0, the lobby.create)
  seq: number;
  author: Pub;
  admin: Pub;
  members: Member[];
  closed: boolean;
}

export interface JoinRequest { pub: Pub; name: string; status: 'pending' | 'admitted' | 'rejected'; reason?: string; ticket: B64 | null }

export interface ConfigEntry { configId: Hex32; config: GameConfig; author: Pub; rosterId: Hex32 }

export interface LobbyState {
  lobbyId: Hex32; code: string;
  head: { rosterId: Hex32; seq: number; admin: Pub; members: Member[]; closed: boolean };
  joins: Map<Hex32, JoinRequest>;
  /** Head members with a leave for their current membership (to be removed by the admin). */
  leaves: Set<Pub>;
  currentConfig: { configId: Hex32; config: GameConfig; author: Pub } | null;
  /** Additions to §11.2: the head chain from the root, and every config of this lobby. */
  chain: ChainNode[];
  configs: Map<Hex32, ConfigEntry>;
}

type Typed<T extends Envelope['type']> = StoredMsg & { env: Envelope<T> };

function typed<T extends Envelope['type']>(m: StoredMsg, type: T): m is Typed<T> {
  return m.env.type === type;
}

/**
 * Lobby fingerprint for verbal confirmation (§4.1): the first 32 bits of the lobbyId, as `XXXX-XXXX`.
 * A msgId hashes the unsigned envelope, so 16 bits could be ground offline in under a second.
 */
export function fingerprintOf(lobbyId: Hex32): string {
  const h = lobbyId.slice(0, 8).toUpperCase();
  return h.slice(0, 4) + '-' + h.slice(4);
}

/** Fingerprint of a public key (§4.1): the first 32 bits of SHA-256 of its `x.y` form, as `XXXX-XXXX`. */
export function pubFingerprint(pub: Pub): string {
  const h = hexEncode(sha256(utf8(pub))).slice(0, 8).toUpperCase();
  return h.slice(0, 4) + '-' + h.slice(4);
}

/**
 * The admin's invite key of a lobby (§4.3): 16 bytes derived from a deterministic (RFC 6979) signature
 * over a domain-separated message, so it survives reloads and nobody else can compute it. It is never
 * published; it travels only in the invite link (`k=`).
 */
export function inviteKeyOf(signer: Signer, lobbyId: Hex32): Uint8Array {
  const sig = signer.sign(concat(INVITE_TAG, hexDecode(lobbyId, 32)));
  return sha256(INVITE_TAG, sig).slice(0, INVITE_KEY_BYTES);
}

/** The ticket a joiner holding the invite key puts in its `lobby.join` (§4.3): HMAC over the lobby and its own pub. */
export function inviteTicket(inviteKey: Uint8Array, lobbyId: Hex32, pub: Pub): B64 {
  return b64uEncode(hmac(nobleSha256, inviteKey, concat(TICKET_TAG, hexDecode(lobbyId, 32), utf8(pub))).slice(0, 16));
}

/** Decodes the `k=` parameter of an invite link; null if malformed. */
export function parseInviteKey(k: string): Uint8Array | null {
  try {
    return b64uDecode(k, INVITE_KEY_BYTES);
  } catch {
    return null;
  }
}

function ticketOk(inviteKey: Uint8Array, lobbyId: Hex32, j: JoinRequest): boolean {
  return j.ticket !== null && j.ticket === inviteTicket(inviteKey, lobbyId, j.pub);
}

function sameMembers(a: readonly Member[], b: readonly Member[]): boolean {
  return a.length === b.length && a.every((m, i) => m.pub === b[i].pub && m.name === b[i].name && m.joinId === b[i].joinId);
}

/** A roster body is well formed: unique pubs and names, valid names, ≤ 10 members, admin a member unless closed. */
function validRosterBody(b: Bodies['lobby.roster']): boolean {
  if (b.members.length > MAX_PLAYERS) return false;
  const pubs = new Set(b.members.map((m) => m.pub));
  const names = new Set(b.members.map((m) => m.name));
  if (pubs.size !== b.members.length || names.size !== b.members.length) return false;
  if (b.members.some((m) => validateName(m.name) !== null)) return false;
  return b.closed || pubs.has(b.admin);
}

function compareHex(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * §4.4 fork choice among the children of `node`. `bound(m)`: the member entry is the creator's own
 * (joinId = lobbyId) or names a `lobby.join` of this lobby whose author is `m.pub` and whose name is
 * `m.name`; a roster with any other entry (a renamed member, a phantom pub) is ignored. A takeover
 * roster must keep the parent's members unchanged.
 */
function chooseChild(node: ChainNode, children: readonly Typed<'lobby.roster'>[], bound: (m: Member) => boolean): Typed<'lobby.roster'> | null {
  const eligible = children.filter((r) => r.env.body.seq === node.seq + 1 && validRosterBody(r.env.body) && r.env.body.members.every(bound));
  const incumbent = eligible.filter((r) => r.env.author === node.admin);
  if (incumbent.length > 0) return incumbent.reduce((a, b) => (compareHex(b.msgId, a.msgId) < 0 ? b : a));
  const memberIdx = (pub: Pub): number => node.members.findIndex((m) => m.pub === pub);
  const takeovers = eligible.filter((r) => r.env.body.admin === r.env.author && memberIdx(r.env.author) >= 0
    && sameMembers(r.env.body.members, node.members));
  if (takeovers.length === 0) return null;
  return takeovers.reduce((a, b) => {
    const d = memberIdx(b.env.author) - memberIdx(a.env.author);
    return d < 0 || (d === 0 && compareHex(b.msgId, a.msgId) < 0) ? b : a;
  });
}

/**
 * Reduces the messages of one lobby (messages of other lobbies are ignored).
 * Throws if the lobby's `lobby.create` is not among `msgs`.
 */
export function reduceLobby(lobbyId: Hex32, msgs: Iterable<StoredMsg>): LobbyState {
  let create: Typed<'lobby.create'> | null = null;
  const children = new Map<Hex32, Typed<'lobby.roster'>[]>();
  const joinMsgs: Typed<'lobby.join'>[] = [];
  const leaveMsgs: Typed<'lobby.leave'>[] = [];
  const configMsgs: Typed<'lobby.config'>[] = [];
  const seen = new Set<Hex32>();
  for (const m of msgs) {
    if (seen.has(m.msgId)) continue;
    seen.add(m.msgId);
    if (typed(m, 'lobby.create')) {
      if (m.msgId === lobbyId) create = m;
      continue;
    }
    if (m.env.lobby !== lobbyId) continue;
    if (typed(m, 'lobby.roster')) {
      const list = children.get(m.env.prev);
      if (list === undefined) children.set(m.env.prev, [m]);
      else list.push(m);
    } else if (typed(m, 'lobby.join')) joinMsgs.push(m);
    else if (typed(m, 'lobby.leave')) leaveMsgs.push(m);
    else if (typed(m, 'lobby.config')) configMsgs.push(m);
  }
  if (create === null) throw new Error(`lobby.create ${lobbyId} not found`);

  // Head chain (§4.4). A closed roster is terminal.
  const creator = create.env.author;
  const creatorName = create.env.body.name;
  const joinById = new Map<Hex32, Typed<'lobby.join'>>(joinMsgs.map((j) => [j.msgId, j]));
  const bound = (m: Member): boolean => {
    if (m.joinId === lobbyId) return m.pub === creator && m.name === creatorName;
    const j = joinById.get(m.joinId);
    return j !== undefined && j.env.author === m.pub && j.env.body.name === m.name;
  };
  const chain: ChainNode[] = [{
    rosterId: lobbyId, seq: 0, author: creator, admin: creator,
    members: [{ pub: creator, name: creatorName, joinId: lobbyId }], closed: false,
  }];
  for (;;) {
    const node = chain[chain.length - 1];
    if (node.closed) break;
    const next = chooseChild(node, children.get(node.rosterId) ?? [], bound);
    if (next === null) break;
    const b = next.env.body;
    chain.push({ rosterId: next.msgId, seq: b.seq, author: next.env.author, admin: b.admin, members: b.members.map((m) => ({ ...m })), closed: b.closed });
  }
  const headNode = chain[chain.length - 1];
  const head = { rosterId: headNode.rosterId, seq: headNode.seq, admin: headNode.admin, members: headNode.members.map((m) => ({ ...m })), closed: headNode.closed };

  // Leaves, keyed by the joinId they end.
  const leftJoinIds = new Map<Hex32, Set<Pub>>();
  for (const l of leaveMsgs) {
    const s = leftJoinIds.get(l.env.prev);
    if (s === undefined) leftJoinIds.set(l.env.prev, new Set([l.env.author]));
    else s.add(l.env.author);
  }
  const hasLeft = (pub: Pub, joinId: Hex32): boolean => leftJoinIds.get(joinId)?.has(pub) === true;

  // Join requests: the latest decision on the head chain wins.
  const joins = new Map<Hex32, JoinRequest>();
  for (const j of joinMsgs) joins.set(j.msgId, { pub: j.env.author, name: j.env.body.name, status: 'pending', ticket: j.env.body.ticket ?? null });
  const rosterById = new Map<Hex32, Typed<'lobby.roster'>>();
  for (const list of children.values()) for (const r of list) rosterById.set(r.msgId, r);
  for (const node of chain.slice(1)) {
    const r = rosterById.get(node.rosterId);
    if (r === undefined) continue;
    for (const m of r.env.body.members) {
      const j = joins.get(m.joinId);
      if (j !== undefined && j.pub === m.pub && j.status !== 'admitted') {
        j.status = 'admitted';
        delete j.reason;
      }
    }
    for (const rej of r.env.body.rejected) {
      const j = joins.get(rej.joinId);
      if (j !== undefined && !r.env.body.members.some((m) => m.joinId === rej.joinId)) {
        j.status = 'rejected';
        j.reason = rej.reason;
      }
    }
  }
  // Members whose current membership has not been left (a leaver may rejoin under a new join).
  const activePubs = new Set(head.members.filter((m) => !hasLeft(m.pub, m.joinId)).map((m) => m.pub));
  for (const [joinId, j] of joins) {
    if (j.status !== 'pending') continue;
    if (hasLeft(j.pub, joinId)) {
      j.status = 'rejected';
      j.reason = 'withdrawn';
    } else if (activePubs.has(j.pub)) {
      j.status = 'admitted';   // moot: the author is already a member under another join
    }
  }

  const leaves = new Set<Pub>(head.members.filter((m) => hasLeft(m.pub, m.joinId)).map((m) => m.pub));

  // Configs (§4.6.4): the current config is the one with the highest roster seq whose prev is on
  // the head chain and whose author is that roster's admin (ties by lowest msgId).
  const configs = new Map<Hex32, ConfigEntry>();
  for (const c of configMsgs) configs.set(c.msgId, { configId: c.msgId, config: c.env.body, author: c.env.author, rosterId: c.env.prev });
  let current: { entry: ConfigEntry; seq: number } | null = null;
  for (const entry of configs.values()) {
    const node = chain.find((n) => n.rosterId === entry.rosterId);
    if (node === undefined || node.admin !== entry.author) continue;
    if (current === null || node.seq > current.seq || (node.seq === current.seq && compareHex(entry.configId, current.entry.configId) < 0)) {
      current = { entry, seq: node.seq };
    }
  }

  return {
    lobbyId,
    code: create.env.body.code,
    head,
    joins,
    leaves,
    currentConfig: current === null ? null
      : { configId: current.entry.configId, config: current.entry.config, author: current.entry.author },
    chain,
    configs,
  };
}

/** Lobby candidates for a code (§4.3): every lobby.create with that code whose head is not closed. */
export function candidates(code: string, msgs: Iterable<StoredMsg>): LobbyCandidate[] {
  const all = [...msgs];
  const out: LobbyCandidate[] = [];
  for (const m of all) {
    if (!typed(m, 'lobby.create') || m.env.body.code !== code || out.some((c) => c.lobbyId === m.msgId)) continue;
    const s = reduceLobby(m.msgId, all);
    if (s.head.closed) continue;
    const admin = s.head.members.find((x) => x.pub === s.head.admin);
    out.push({
      lobbyId: s.lobbyId, code: s.code, adminPub: s.head.admin, adminName: admin?.name ?? '',
      members: s.head.members.map((x) => x.name), fingerprint: fingerprintOf(s.lobbyId), adminFingerprint: pubFingerprint(s.head.admin),
    });
  }
  return out.sort((a, b) => compareHex(a.lobbyId, b.lobbyId));
}

/** Local facts checkConfig needs besides the lobby state (§4.6.2). */
export interface ConfigCheckLocal {
  activeGameIds: string[];
  knownGame?: { gameId: string; configId: Hex32 };
  /** Whether step `key` of a config completed (a game started); default: none known. */
  keyComplete?: (configId: Hex32) => boolean;
  /** Milliseconds since this device received a roster; null/undefined = just now. */
  rosterAgeMs?: (rosterId: Hex32) => number | null | undefined;
}

export type ConfigCheck = { ok: true; seat: number } | { ok: false; reason: string; retryAfterMs?: number };

/**
 * The takeovers (§4.5) on the head chain up to `upto` (inclusive) that still stand open: the chain
 * index of each takeover roster and the admin it ousted. A takeover is closed once a game started
 * (key complete) on a config based on a roster at or after it.
 */
function openTakeovers(state: LobbyState, upto: number, keyComplete: (configId: Hex32) => boolean): { idx: number; ousted: Pub }[] {
  const out: { idx: number; ousted: Pub }[] = [];
  const started = new Set<Hex32>();
  for (const c of state.configs.values()) if (keyComplete(c.configId)) started.add(c.rosterId);
  for (let i = 1; i <= upto && i < state.chain.length; i++) {
    const parent = state.chain[i - 1];
    const node = state.chain[i];
    if (node.author === parent.admin) continue;
    if (state.chain.slice(i).some((n) => started.has(n.rosterId))) continue;
    out.push({ idx: i, ousted: parent.admin });
  }
  return out;
}

/**
 * Whether this seat accepts the lobby's current config (§4.6.2). On success it
 * returns its seat index; the caller then writes the games record and keys.
 * A refusal with `retryAfterMs` is temporary (a recent takeover, §4.5).
 */
export function checkConfig(state: LobbyState, me: Pub, local: ConfigCheckLocal): ConfigCheck {
  const cur = state.currentConfig;
  if (cur === null) return { ok: false, reason: 'No game configuration' };
  const { config, configId, author } = cur;
  if (state.head.closed) return { ok: false, reason: 'The lobby is closed' };
  if (author !== state.head.admin) return { ok: false, reason: 'The configuration is not from the lobby admin' };
  const entry = state.configs.get(configId);
  const baseIdx = entry === undefined ? -1 : state.chain.findIndex((n) => n.rosterId === entry.rosterId);
  if (baseIdx < 0) return { ok: false, reason: 'The configuration is not based on the current roster' };
  const base = state.chain[baseIdx];
  for (const node of state.chain.slice(baseIdx + 1)) {
    if (node.admin !== base.admin || !sameMembers(node.members, base.members)) {
      return { ok: false, reason: 'The lobby changed after the game was configured' };
    }
  }
  // §4.5 takeovers: the ousted admin never keys a game based on its own takeover (it reclaims instead,
  // and `key` needs every seat), and the other seats give a returning admin 60 s to reclaim first.
  const keyDone = local.keyComplete ?? ((): boolean => false);
  for (const t of openTakeovers(state, baseIdx, keyDone)) {
    if (t.ousted === me) return { ok: false, reason: 'Another player took over your lobby; reclaiming it' };
    const age = local.rosterAgeMs?.(state.chain[t.idx].rosterId) ?? 0;
    if (age < TAKEOVER_SETTLE_MS) {
      return { ok: false, reason: 'The lobby admin changed less than a minute ago', retryAfterMs: TAKEOVER_SETTLE_MS - Math.max(0, age) };
    }
  }
  const n = config.seats.length;
  if (n < MIN_PLAYERS || n > MAX_PLAYERS) return { ok: false, reason: `Bad number of players: ${n}` };
  const pubs = new Set(config.seats.map((s) => s.pub));
  const names = new Set(config.seats.map((s) => s.name));
  if (pubs.size !== n || names.size !== n) return { ok: false, reason: 'Duplicate players' };
  if (config.seats.some((s) => validateName(s.name) !== null)) return { ok: false, reason: 'Invalid player name' };
  const members = state.head.members;
  if (members.length !== n || !members.every((m) => config.seats.some((s) => s.pub === m.pub && s.name === m.name))) {
    return { ok: false, reason: 'The players do not match the lobby members' };
  }
  if (!validateSelectedRoles(config.selectedRoles)) return { ok: false, reason: 'Invalid role selection' };
  if (config.rulesHash !== RULES_HASH) return { ok: false, reason: 'This game uses different rules. Reload to update' };
  if (local.knownGame !== undefined && local.knownGame.gameId === config.gameId && local.knownGame.configId !== configId) {
    return { ok: false, reason: 'This device already accepted another configuration of this game' };
  }
  // Equivocation is two configs of one gameId by the same author; a copy by anybody else (lobby
  // souls are writable by anyone) neither proves anything about the admin nor blocks the start.
  for (const other of state.configs.values()) {
    if (other.configId !== configId && other.author === author && other.config.gameId === config.gameId) {
      return { ok: false, reason: 'The admin published two configurations of this game' };
    }
  }
  if (local.activeGameIds.some((g) => g !== config.gameId)) return { ok: false, reason: 'You are in another game' };
  const seat = config.seats.findIndex((s) => s.pub === me);
  if (seat < 0) return { ok: false, reason: 'You are not seated in this game' };
  return { ok: true, seat };
}

/**
 * The other `lobby.config` messages of the same lobby and author with the same
 * gameId as `configId` (input of reduceGame, §4.6): only the config's own
 * author can equivocate on it.
 */
export function conflictingConfigs(configId: Hex32, msgs: Iterable<StoredMsg>): StoredMsg[] {
  const all = [...msgs].filter((m) => typed(m, 'lobby.config'));
  const mine = all.find((m) => m.msgId === configId);
  if (mine === undefined) return [];
  const gameId = (mine.env.body as GameConfig).gameId;
  const lobby = mine.env.lobby;
  const author = mine.env.author;
  const out = new Map<Hex32, StoredMsg>();
  for (const m of all) {
    if (m.msgId !== configId && m.env.lobby === lobby && m.env.author === author && (m.env.body as GameConfig).gameId === gameId) {
      out.set(m.msgId, m);
    }
  }
  return [...out.values()].sort((a, b) => compareHex(a.msgId, b.msgId));
}

export type LobbyAction =
  | { kind: 'roster'; body: Bodies['lobby.roster']; prev?: Hex32 }   // prev defaults to head.rosterId
  | { kind: 'none' };

/** Admin-side inputs of adminNextAction besides the lobby state. */
export interface AdminOptions {
  /**
   * The admin's invite key (§4.3): a valid join carrying a matching ticket is admitted automatically,
   * any other valid join waits for the admin's approval (`approved`). Omitted: every valid join is
   * admitted automatically (tests, simulations).
   */
  inviteKey?: Uint8Array;
  /** Join requests the admin approved by hand. */
  approved?: ReadonlySet<Hex32>;
  /** Join requests the admin declined by hand. */
  declined?: ReadonlySet<Hex32>;
  /** Whether step `key` of a config completed: a started game on a takeover branch blocks the reclaim (§4.5). */
  keyComplete?: (configId: Hex32) => boolean;
}

/**
 * The admin client's next automatic roster (§4.3-4.5): reclaim after a takeover,
 * removal of leavers, admission or rejection of join requests (in `joins`
 * iteration order, i.e. ingestion order, at most MAX_REJECTIONS_PER_ROSTER
 * rejections per roster). `gameActive` = a config is pending or a game is
 * non-terminal: then only rejection-only rosters are produced.
 */
export function adminNextAction(state: LobbyState, me: Pub, gameActive: boolean, opts: AdminOptions = {}): LobbyAction {
  const { head, chain } = state;
  if (head.closed) return { kind: 'none' };

  if (head.admin !== me) {
    // Reclaim (§4.5): the latest takeover on the head chain of a roster this device administered,
    // unless a game started (key complete) on the takeover branch. A running game of either branch
    // is unaffected (§4.6.4), so neither gameActive nor a mere config blocks the reclaim.
    const keyDone = opts.keyComplete ?? ((): boolean => false);
    for (let i = chain.length - 2; i >= 0; i--) {
      const node = chain[i];
      const child = chain[i + 1];
      if (child.author === me) return { kind: 'none' };
      if (node.admin === me && child.author !== node.admin) {
        const branch = new Set(chain.slice(i + 1).map((n) => n.rosterId));
        if ([...state.configs.values()].some((c) => branch.has(c.rosterId) && keyDone(c.configId))) return { kind: 'none' };
        return {
          kind: 'roster',
          prev: node.rosterId,
          body: { seq: node.seq + 1, admin: me, members: node.members.map((m) => ({ ...m })), rejected: [], closed: false },
        };
      }
    }
    return { kind: 'none' };
  }

  let members = head.members.map((m) => ({ ...m }));
  let changed = false;
  if (!gameActive) {
    const before = members.length;
    members = members.filter((m) => m.pub === me || !state.leaves.has(m.pub));
    changed = members.length !== before;
  }
  const rejected: { joinId: Hex32; reason: RejectReason }[] = [];
  for (const [joinId, j] of state.joins) {
    if (rejected.length >= MAX_REJECTIONS_PER_ROSTER) break;
    if (j.status !== 'pending' || members.some((m) => m.pub === j.pub)) continue;
    let reason: RejectReason | null = null;
    if (gameActive) reason = 'game-active';
    else if (validateName(j.name) !== null) reason = 'invalid-name';
    else if (opts.declined?.has(joinId) === true) reason = 'declined';
    else if (members.some((m) => m.name === j.name)) reason = 'name-taken';
    else if (members.length >= MAX_PLAYERS) reason = 'full';
    if (reason === null) {
      const auto = opts.inviteKey === undefined || ticketOk(opts.inviteKey, state.lobbyId, j) || opts.approved?.has(joinId) === true;
      if (!auto) continue;   // waits for the admin's approval
      members.push({ pub: j.pub, name: j.name, joinId });
      changed = true;
    } else {
      rejected.push({ joinId, reason });
    }
  }
  if (!changed && rejected.length === 0) return { kind: 'none' };
  return { kind: 'roster', body: { seq: head.seq + 1, admin: me, members, rejected, closed: false } };
}

/** Pending join requests that wait for the admin's approval (no valid ticket, §4.3), oldest first. */
export function awaitingApproval(state: LobbyState, inviteKey: Uint8Array): { joinId: Hex32; pub: Pub; name: string }[] {
  const out: { joinId: Hex32; pub: Pub; name: string }[] = [];
  for (const [joinId, j] of state.joins) {
    if (j.status !== 'pending' || state.head.members.some((m) => m.pub === j.pub)) continue;
    if (validateName(j.name) !== null || ticketOk(inviteKey, state.lobbyId, j)) continue;
    out.push({ joinId, pub: j.pub, name: j.name });
  }
  return out;
}

/** The member entry of `pub` in the head roster, if any. */
export function memberOf(state: LobbyState, pub: Pub): Member | undefined {
  return state.head.members.find((m) => m.pub === pub);
}

/** User-facing error text for a roster rejection reason (§4.3). */
export function rejectionMessage(reason: string): string {
  switch (reason) {
    case 'name-taken': return 'Name taken';
    case 'invalid-name': return 'Invalid name';
    case 'full': return 'Lobby full';
    case 'game-active': return 'Cannot join while game is in progress';
    case 'withdrawn': return 'Join request withdrawn';
    case 'declined': return 'The admin declined your request';
    default: return reason;
  }
}
