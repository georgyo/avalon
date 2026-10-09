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
import type { Hex32, Pub } from '../crypto/types.ts';
import { MAX_PLAYERS, MIN_PLAYERS, RULES_HASH, validateName, validateSelectedRoles } from './rules.ts';
import type { Bodies, Envelope, GameConfig, Member, RejectReason, StoredMsg } from './types.ts';

export interface LobbyCandidate { lobbyId: Hex32; code: string; adminPub: Pub; adminName: string; members: string[]; fingerprint: string }

export interface ChainNode {
  rosterId: Hex32;           // the lobbyId for the root (seq 0, the lobby.create)
  seq: number;
  author: Pub;
  admin: Pub;
  members: Member[];
  closed: boolean;
}

export interface JoinRequest { pub: Pub; name: string; status: 'pending' | 'admitted' | 'rejected'; reason?: string }

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

export function fingerprintOf(lobbyId: Hex32): string {
  return lobbyId.slice(0, 4).toUpperCase();
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

/** §4.4 fork choice among the children of `node`. */
function chooseChild(node: ChainNode, children: readonly Typed<'lobby.roster'>[]): Typed<'lobby.roster'> | null {
  const eligible = children.filter((r) => r.env.body.seq === node.seq + 1 && validRosterBody(r.env.body));
  const incumbent = eligible.filter((r) => r.env.author === node.admin);
  if (incumbent.length > 0) return incumbent.reduce((a, b) => (compareHex(b.msgId, a.msgId) < 0 ? b : a));
  const memberIdx = (pub: Pub): number => node.members.findIndex((m) => m.pub === pub);
  const takeovers = eligible.filter((r) => r.env.body.admin === r.env.author && memberIdx(r.env.author) >= 0);
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
  const chain: ChainNode[] = [{
    rosterId: lobbyId, seq: 0, author: creator, admin: creator,
    members: [{ pub: creator, name: create.env.body.name, joinId: lobbyId }], closed: false,
  }];
  for (;;) {
    const node = chain[chain.length - 1];
    if (node.closed) break;
    const next = chooseChild(node, children.get(node.rosterId) ?? []);
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
  for (const j of joinMsgs) joins.set(j.msgId, { pub: j.env.author, name: j.env.body.name, status: 'pending' });
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
      members: s.head.members.map((x) => x.name), fingerprint: fingerprintOf(s.lobbyId),
    });
  }
  return out.sort((a, b) => compareHex(a.lobbyId, b.lobbyId));
}

/**
 * Whether this seat accepts the lobby's current config (§4.6.2). On success it
 * returns its seat index; the caller then writes the games record and keys.
 */
export function checkConfig(
  state: LobbyState, me: Pub,
  local: { activeGameIds: string[]; knownGame?: { gameId: string; configId: Hex32 } },
): { ok: true; seat: number } | { ok: false; reason: string } {
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
  for (const other of state.configs.values()) {
    if (other.configId !== configId && other.config.gameId === config.gameId) {
      return { ok: false, reason: 'The admin published two configurations of this game' };
    }
  }
  if (local.activeGameIds.some((g) => g !== config.gameId)) return { ok: false, reason: 'You are in another game' };
  const seat = config.seats.findIndex((s) => s.pub === me);
  if (seat < 0) return { ok: false, reason: 'You are not seated in this game' };
  return { ok: true, seat };
}

/** The other `lobby.config` messages with the same gameId as `configId` (input of reduceGame, §4.6). */
export function conflictingConfigs(configId: Hex32, msgs: Iterable<StoredMsg>): StoredMsg[] {
  const all = [...msgs].filter((m) => typed(m, 'lobby.config'));
  const mine = all.find((m) => m.msgId === configId);
  if (mine === undefined) return [];
  const gameId = (mine.env.body as GameConfig).gameId;
  const lobby = mine.env.lobby;
  const out = new Map<Hex32, StoredMsg>();
  for (const m of all) {
    if (m.msgId !== configId && m.env.lobby === lobby && (m.env.body as GameConfig).gameId === gameId) out.set(m.msgId, m);
  }
  return [...out.values()].sort((a, b) => compareHex(a.msgId, b.msgId));
}

export type LobbyAction =
  | { kind: 'roster'; body: Bodies['lobby.roster']; prev?: Hex32 }   // prev defaults to head.rosterId
  | { kind: 'none' };

/**
 * The admin client's next automatic roster (§4.3-4.5): reclaim after a takeover,
 * removal of leavers, admission or rejection of join requests (in `joins`
 * iteration order, i.e. ingestion order). `gameActive` = a config is pending
 * or a game is non-terminal: then only rejection-only rosters are produced.
 */
export function adminNextAction(state: LobbyState, me: Pub, gameActive: boolean): LobbyAction {
  const { head, chain } = state;
  if (head.closed) return { kind: 'none' };

  if (head.admin !== me) {
    // Reclaim (§4.5): the latest takeover on the head chain of a roster this device administered.
    if (gameActive) return { kind: 'none' };
    for (let i = chain.length - 2; i >= 0; i--) {
      const node = chain[i];
      const child = chain[i + 1];
      if (child.author === me) return { kind: 'none' };
      if (node.admin === me && child.author !== node.admin) {
        // Not once a game was configured on the takeover branch (§4.5: a started game keeps it).
        const branch = new Set(chain.slice(i + 1).map((n) => n.rosterId));
        if ([...state.configs.values()].some((c) => branch.has(c.rosterId))) return { kind: 'none' };
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
    if (j.status !== 'pending' || members.some((m) => m.pub === j.pub)) continue;
    let reason: RejectReason | null = null;
    if (gameActive) reason = 'game-active';
    else if (validateName(j.name) !== null) reason = 'invalid-name';
    else if (members.some((m) => m.name === j.name)) reason = 'name-taken';
    else if (members.length >= MAX_PLAYERS) reason = 'full';
    if (reason === null) {
      members.push({ pub: j.pub, name: j.name, joinId });
      changed = true;
    } else {
      rejected.push({ joinId, reason });
    }
  }
  if (!changed && rejected.length === 0) return { kind: 'none' };
  return { kind: 'roster', body: { seq: head.seq + 1, admin: me, members, rejected, closed: false } };
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
    default: return reason;
  }
}
