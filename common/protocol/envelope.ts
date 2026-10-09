/**
 * Envelope codec, signing and souls (docs/p2p-protocol.md §3.1-3.4).
 *
 *   mBytes = utf8(canon(m))
 *   msgId  = SHA256(utf8("avalon-p2p/v1/msg\0") ‖ mBytes)
 *   sig    = p256.sign(utf8("avalon-p2p/v1/sig\0") ‖ msgId, priv, { prehash: true, lowS: true })
 *   value  = "AV1." + b64url(mBytes) + "." + b64url(sig)
 *   key    = hex(SHA256(utf8(value)))
 *
 * `parseEnvelope` is the strict schema of §3.3: exact key sets, canonical
 * encodings, integers in range, well-formed step ids, bounded arrays. Checks
 * that need the game config (array lengths equal to n, R, team sizes, point
 * validity and the identity rules of §2.3) belong to the step validators.
 */
import { p256 } from '@noble/curves/nist.js';
import { b64uDecode, b64uEncode, canon, CodecError, concat, hexEncode, parseCanon, sha256, utf8 } from '../crypto/bytes.ts';
import { decScalar } from '../crypto/group.ts';
import type { B64, CtE, Hex32, Pub, SigmaProofE } from '../crypto/types.ts';
import { LOBBY_CODE_RE, MAX_PLAYERS, MAX_PROPOSALS, MIN_PLAYERS, NUM_MISSIONS, validateName, validateSelectedRoles } from './rules.ts';
import {
  type Bodies, type Envelope, type GameConfig, type LogBundle, type Member, type MsgType, type StoredMsg,
  LOBBY_MSG_TYPES, MSG_TYPES, PLAY_MSG_TYPES, SETUP_MSG_TYPES,
} from './types.ts';
import type { GameOutcome, Mission, Proposal, RoleAssignment } from './views.ts';

export const VALUE_PREFIX = 'AV1.';
export const MAX_VALUE_LENGTH = 65536;
const MSG_TAG = utf8('avalon-p2p/v1/msg\0');
const SIG_TAG = utf8('avalon-p2p/v1/sig\0');
const SIG_OPTS = { prehash: true, lowS: true } as const;

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeError';
  }
}

// ---------------------------------------------------------------- SEA public keys

const pubCache = new Map<string, Uint8Array>();

/** `0x04 ‖ x ‖ y` (65 bytes) of a SEA pub `"x.y"`; throws EnvelopeError unless it is a valid P-256 point. */
export function pubBytes(pub: Pub): Uint8Array {
  const cached = pubCache.get(pub);
  if (cached !== undefined) return cached;
  if (typeof pub !== 'string' || pub.length !== 87 || pub[43] !== '.') throw new EnvelopeError('pub: malformed');
  let bytes: Uint8Array;
  try {
    bytes = concat(Uint8Array.of(4), b64uDecode(pub.slice(0, 43), 32), b64uDecode(pub.slice(44), 32));
    p256.Point.fromBytes(bytes).assertValidity();
  } catch {
    throw new EnvelopeError('pub: not a P-256 point');
  }
  if (pubCache.size > 4096) pubCache.clear();
  pubCache.set(pub, bytes);
  return bytes;
}

export function isPub(v: unknown): v is Pub {
  if (typeof v !== 'string') return false;
  try {
    pubBytes(v);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- signer

/** Deterministic (RFC 6979) P-256 ECDSA, low-S, over SHA-256 of the message. */
export interface Signer { pub: Pub; sign(msg: Uint8Array): Uint8Array }

export function signerFromPair(pair: { pub: Pub; priv: string }): Signer {
  const priv = b64uDecode(pair.priv, 32);
  const expected = pubBytes(pair.pub);
  const actual = p256.getPublicKey(priv, false);
  if (hexEncode(actual) !== hexEncode(expected)) throw new EnvelopeError('signer: priv does not match pub');
  return {
    pub: pair.pub,
    sign: (msg: Uint8Array): Uint8Array => p256.sign(msg, priv, SIG_OPTS),
  };
}

function msgIdBytes(mBytes: Uint8Array): Uint8Array {
  return sha256(MSG_TAG, mBytes);
}

/** Signature input: utf8("avalon-p2p/v1/sig\0") ‖ msgId (32 bytes). */
export function sigInput(msgId: Uint8Array): Uint8Array {
  return concat(SIG_TAG, msgId);
}

export function verifySig(pub: Pub, msgId: Uint8Array, sig: Uint8Array): boolean {
  try {
    return sig.length === 64 && p256.verify(sig, sigInput(msgId), pubBytes(pub), SIG_OPTS);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- encode / decode

export function msgIdOf(env: Envelope): Hex32 {
  return hexEncode(msgIdBytes(utf8(canon(env))));
}

export function gunKeyOf(value: string): Hex32 {
  return hexEncode(sha256(utf8(value)));
}

/**
 * Signs and encodes an envelope. The envelope is validated with the same strict
 * schema receivers use, so this never produces a value peers would drop.
 */
export function encodeEnvelope(env: Envelope, signer: Signer): { value: string; key: Hex32; msgId: Hex32 } {
  if (env.author !== signer.pub) throw new EnvelopeError('encode: author is not the signer');
  const mStr = canon(env);
  parseEnvelope(JSON.parse(mStr));
  const mBytes = utf8(mStr);
  const id = msgIdBytes(mBytes);
  const sig = signer.sign(sigInput(id));
  if (sig.length !== 64) throw new EnvelopeError('encode: signer returned a non-compact signature');
  const value = VALUE_PREFIX + b64uEncode(mBytes) + '.' + b64uEncode(sig);
  if (value.length > MAX_VALUE_LENGTH) throw new EnvelopeError(`encode: value too long (${value.length})`);
  return { value, key: gunKeyOf(value), msgId: hexEncode(id) };
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Steps 1-2 of the ingestion pipeline (§3.4): value shape and length, GUN key
 * (when given), strict decoding, schema, msgId, signature.
 */
export function decodeEnvelope(value: string, key?: string): StoredMsg | { error: string } {
  if (typeof value !== 'string') return { error: 'value is not a string' };
  if (!value.startsWith(VALUE_PREFIX)) return { error: 'value does not start with AV1.' };
  if (value.length > MAX_VALUE_LENGTH) return { error: 'value too long' };
  const gunKey = gunKeyOf(value);
  if (key !== undefined && key !== gunKey) return { error: 'key is not the hash of the value' };
  const parts = value.split('.');
  if (parts.length !== 3) return { error: 'value must have three parts' };
  let env: Envelope;
  let sig: Uint8Array;
  let mBytes: Uint8Array;
  try {
    mBytes = b64uDecode(parts[1]);
    sig = b64uDecode(parts[2], 64);
    env = parseEnvelope(parseCanon(utf8Decoder.decode(mBytes)));
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'malformed value' };
  }
  const id = msgIdBytes(mBytes);
  if (!verifySig(env.author, id, sig)) return { error: 'bad signature' };
  return { msgId: hexEncode(id), env, value, key: gunKey };
}

// ---------------------------------------------------------------- souls

export function lobbySoul(code: string): string {
  if (!LOBBY_CODE_RE.test(code)) throw new EnvelopeError(`invalid lobby code: ${code}`);
  return `avalon/v1/lobby/${code}#`;
}

export function gameSoul(gameId: B64, part: 'setup' | 'play'): string {
  if (!GAME_ID_RE.test(gameId)) throw new EnvelopeError(`invalid gameId: ${gameId}`);
  return `avalon/v1/game/${gameId}/${part}#`;
}

export function logSoul(month: string): string {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new EnvelopeError(`invalid month: ${month}`);
  return `avalon/v1/logs/${month}#`;
}

function intDiv(a: number, b: number): number {
  return (a - (a % b)) / b;
}

/** "YYYY-MM" (UTC) of a non-negative millisecond timestamp, in integer arithmetic (no Date, §11.1). */
export function monthOf(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new EnvelopeError(`invalid timestamp: ${ms}`);
  // Howard Hinnant's civil_from_days, all operands non-negative.
  const z = intDiv(ms, 86400000) + 719468;
  const era = intDiv(z, 146097);
  const doe = z - era * 146097;
  const yoe = intDiv(doe - intDiv(doe, 1460) + intDiv(doe, 36524) - intDiv(doe, 146096), 365);
  const doy = doe - (365 * yoe + intDiv(yoe, 4) - intDiv(yoe, 100));
  const mp = intDiv(5 * doy + 2, 153);
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0');
}

/** The soul an envelope is stored in (§3.1). `lobbyCode` is used for lobby messages. */
export function soulOf(env: Envelope, lobbyCode: string): string {
  if ((LOBBY_MSG_TYPES as readonly string[]).includes(env.type)) return lobbySoul(lobbyCode);
  if ((SETUP_MSG_TYPES as readonly string[]).includes(env.type)) return gameSoul(env.game, 'setup');
  if ((PLAY_MSG_TYPES as readonly string[]).includes(env.type)) return gameSoul(env.game, 'play');
  if (env.type === 'log') return logSoul(monthOf((env.body as LogBundle).createdAt));
  throw new EnvelopeError(`unknown type ${String(env.type)}`);
}

// ---------------------------------------------------------------- step ids

const IDX = '(?:0|[1-9][0-9]*)';
const STEP_RE: Record<string, RegExp> = {
  key: /^key$/,
  shuffle: new RegExp(`^shuf/(${IDX})$`),
  deal: /^deal$/,
  'ot.recv': /^otR$/,
  'ot.send': /^otS$/,
  propose: new RegExp(`^p/(${IDX})/(${IDX})$`),
  'vote.commit': new RegExp(`^vc/(${IDX})/(${IDX})$`),
  'vote.reveal': new RegExp(`^vr/(${IDX})/(${IDX})$`),
  ballot: new RegExp(`^mv/(${IDX})$`),
  tally: new RegExp(`^mt/(${IDX})$`),
  assassinate: /^as$/,
  cancel: /^cancel$/,
  reveal: /^reveal$/,
};

/** Whether `step` is a well-formed step id for a message of `type` (§3.5); '' for lobby and log messages. */
export function isStepFor(type: MsgType, step: string): boolean {
  if ((LOBBY_MSG_TYPES as readonly string[]).includes(type) || type === 'log') return step === '';
  const re = STEP_RE[type];
  const m = re === undefined ? null : re.exec(step);
  if (m === null) return false;
  if (type === 'shuffle') return Number(m[1]) < MAX_PLAYERS;
  if (type === 'propose' || type === 'vote.commit' || type === 'vote.reveal') {
    return Number(m[1]) < NUM_MISSIONS && Number(m[2]) < MAX_PROPOSALS;
  }
  if (type === 'ballot' || type === 'tally') return Number(m[1]) < NUM_MISSIONS;
  return true;
}

/** A step id a cancel may target (`body.at`): any step id of a stepped message type. */
export function isGameStepId(step: string): boolean {
  const types: MsgType[] = ['key', 'shuffle', 'deal', 'ot.recv', 'ot.send', 'propose', 'vote.commit', 'vote.reveal', 'ballot', 'tally', 'assassinate'];
  return types.some((t) => isStepFor(t, step));
}

// ---------------------------------------------------------------- schema helpers

const HEX32_RE = /^[0-9a-f]{64}$/;
const GAME_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const MAX_TEXT = 1024;
const MAX_LIST = 256;

type Obj = Record<string, unknown>;

function fail(path: string, what: string): never {
  throw new EnvelopeError(`${path}: ${what}`);
}

function obj(v: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Obj {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(path, 'expected an object');
  const o = v as Obj;
  for (const k of Object.keys(o)) {
    if (!required.includes(k) && !optional.includes(k)) fail(path, `unknown key ${k}`);
  }
  for (const k of required) {
    if (!Object.prototype.hasOwnProperty.call(o, k)) fail(path, `missing key ${k}`);
  }
  return o;
}

function arr(v: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(v)) fail(path, 'expected an array');
  if (v.length < min || v.length > max) fail(path, `length ${v.length} not in [${min}, ${max}]`);
  return v;
}

function str(v: unknown, path: string, maxLen = MAX_TEXT): string {
  if (typeof v !== 'string') fail(path, 'expected a string');
  if (v.length > maxLen) fail(path, 'string too long');
  return v;
}

function matches(v: unknown, path: string, re: RegExp): string {
  const s = str(v, path);
  if (!re.test(s)) fail(path, 'malformed');
  return s;
}

function oneOf<T extends string>(v: unknown, path: string, values: readonly T[]): T {
  const s = str(v, path);
  if (!(values as readonly string[]).includes(s)) fail(path, `unexpected value ${s}`);
  return s as T;
}

function int(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) fail(path, 'expected an integer');
  if (v < min || v > max) fail(path, `${v} not in [${min}, ${max}]`);
  return v;
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') fail(path, 'expected a boolean');
  return v;
}

function hex32(v: unknown, path: string): Hex32 {
  return matches(v, path, HEX32_RE);
}

function bytes(v: unknown, path: string, len: number): B64 {
  const s = str(v, path);
  try {
    b64uDecode(s, len);
  } catch (e) {
    fail(path, e instanceof CodecError ? e.message : 'bad base64url');
  }
  return s;
}

/** A canonical 32-byte point encoding (validity and identity are checked by the step validators). */
function pt(v: unknown, path: string): string {
  return bytes(v, path, 32);
}

function sc(v: unknown, path: string): string {
  const s = str(v, path);
  try {
    decScalar(s);
  } catch (e) {
    fail(path, e instanceof Error ? e.message : 'bad scalar');
  }
  return s;
}

function pub(v: unknown, path: string): Pub {
  if (!isPub(v)) fail(path, 'invalid pub');
  return v;
}

function playerName(v: unknown, path: string): string {
  const s = str(v, path);
  if (validateName(s) !== null) fail(path, 'invalid name');
  return s;
}

function cte(v: unknown, path: string): CtE {
  const o = obj(v, path, ['a', 'b']);
  return { a: pt(o.a, path + '.a'), b: pt(o.b, path + '.b') };
}

function proof(v: unknown, path: string): SigmaProofE {
  const o = obj(v, path, ['K', 'e', 's']);
  const K = arr(o.K, path + '.K', 1, 16).map((b, i) => arr(b, `${path}.K[${i}]`, 1, MAX_LIST).map((p, j) => pt(p, `${path}.K[${i}][${j}]`)));
  const e = arr(o.e, path + '.e', K.length, K.length).map((x, i) => sc(x, `${path}.e[${i}]`));
  const s = arr(o.s, path + '.s', K.length, K.length).map((b, i) => arr(b, `${path}.s[${i}]`, 1, MAX_LIST).map((x, j) => sc(x, `${path}.s[${i}][${j}]`)));
  return { K, e, s };
}

function names(v: unknown, path: string, max = MAX_PLAYERS): string[] {
  return arr(v, path, 0, max).map((x, i) => playerName(x, `${path}[${i}]`));
}

function proposalSchema(v: unknown, path: string): Proposal {
  const o = obj(v, path, ['proposer', 'team', 'votes', 'state']);
  return {
    proposer: playerName(o.proposer, path + '.proposer'),
    team: names(o.team, path + '.team'),
    votes: names(o.votes, path + '.votes'),
    state: oneOf(o.state, path + '.state', ['PENDING', 'APPROVED', 'REJECTED'] as const),
  };
}

function missionSchema(v: unknown, path: string): Mission {
  const o = obj(v, path, ['state', 'team', 'teamSize', 'failsRequired', 'numFails', 'proposals'], ['evilOnTeam']);
  const m: Mission = {
    state: oneOf(o.state, path + '.state', ['PENDING', 'SUCCESS', 'FAIL'] as const),
    team: names(o.team, path + '.team'),
    teamSize: int(o.teamSize, path + '.teamSize', 0, MAX_PLAYERS),
    failsRequired: int(o.failsRequired, path + '.failsRequired', 0, MAX_PLAYERS),
    numFails: int(o.numFails, path + '.numFails', 0, MAX_PLAYERS),
    proposals: arr(o.proposals, path + '.proposals', 0, MAX_PROPOSALS).map((p, i) => proposalSchema(p, `${path}.proposals[${i}]`)),
  };
  if (o.evilOnTeam !== undefined) m.evilOnTeam = names(o.evilOnTeam, path + '.evilOnTeam');
  return m;
}

function outcomeSchema(v: unknown, path: string): GameOutcome {
  const o = obj(v, path, ['state', 'message', 'roles', 'votes', 'final', 'unrevealed', 'cheaters'],
    ['assassinated', 'canceledBy', 'stalled']);
  const out: GameOutcome = {
    state: oneOf(o.state, path + '.state', ['GOOD_WIN', 'EVIL_WIN', 'CANCELED'] as const),
    message: str(o.message, path + '.message'),
    roles: arr(o.roles, path + '.roles', 0, MAX_PLAYERS).map((r, i): RoleAssignment => {
      const p = `${path}.roles[${i}]`;
      const ro = obj(r, p, ['name', 'role'], ['assassin']);
      const ra: RoleAssignment = { name: playerName(ro.name, p + '.name'), role: str(ro.role, p + '.role', 32) };
      if (ro.assassin !== undefined) ra.assassin = bool(ro.assassin, p + '.assassin');
      return ra;
    }),
    votes: arr(o.votes, path + '.votes', 0, NUM_MISSIONS).map((m, i) => {
      const p = `${path}.votes[${i}]`;
      if (m === null || typeof m !== 'object' || Array.isArray(m)) fail(p, 'expected an object');
      const rec: Record<string, boolean> = {};
      const entries = Object.entries(m as Obj);
      if (entries.length > MAX_PLAYERS) fail(p, 'too many votes');
      for (const [k, b] of entries) rec[playerName(k, p + '.key')] = bool(b, `${p}.${k}`);
      return rec;
    }),
    final: bool(o.final, path + '.final'),
    unrevealed: names(o.unrevealed, path + '.unrevealed'),
    cheaters: arr(o.cheaters, path + '.cheaters', 0, MAX_PLAYERS).map((c, i) => {
      const p = `${path}.cheaters[${i}]`;
      const co = obj(c, p, ['name', 'reason']);
      return { name: playerName(co.name, p + '.name'), reason: str(co.reason, p + '.reason') };
    }),
  };
  if (o.assassinated !== undefined) out.assassinated = playerName(o.assassinated, path + '.assassinated');
  if (o.canceledBy !== undefined) out.canceledBy = playerName(o.canceledBy, path + '.canceledBy');
  if (o.stalled !== undefined) out.stalled = names(o.stalled, path + '.stalled');
  return out;
}

function configSchema(v: unknown, path: string): GameConfig {
  const o = obj(v, path, ['gameId', 'seats', 'selectedRoles', 'options', 'rulesHash']);
  const gameId = matches(o.gameId, path + '.gameId', GAME_ID_RE);
  bytes(gameId, path + '.gameId', 16);
  const seats = arr(o.seats, path + '.seats', MIN_PLAYERS, MAX_PLAYERS).map((s, i) => {
    const p = `${path}.seats[${i}]`;
    const so = obj(s, p, ['pub', 'name']);
    return { pub: pub(so.pub, p + '.pub'), name: playerName(so.name, p + '.name') };
  });
  const selectedRoles = arr(o.selectedRoles, path + '.selectedRoles', 0, 16).map((r, i) => str(r, `${path}.selectedRoles[${i}]`, 32));
  if (!validateSelectedRoles(selectedRoles)) fail(path + '.selectedRoles', 'invalid role selection');
  const opts = obj(o.options, path + '.options', ['inGameLog']);
  return {
    gameId, seats, selectedRoles,
    options: { inGameLog: bool(opts.inGameLog, path + '.options.inGameLog') },
    rulesHash: hex32(o.rulesHash, path + '.rulesHash'),
  };
}

function memberSchema(v: unknown, path: string): Member {
  const o = obj(v, path, ['pub', 'name', 'joinId']);
  return { pub: pub(o.pub, path + '.pub'), name: playerName(o.name, path + '.name'), joinId: hex32(o.joinId, path + '.joinId') };
}

function logSchema(v: unknown, path: string): LogBundle {
  const o = obj(v, path, ['gameId', 'configId', 'lobbyCode', 'outcome', 'missions', 'players', 'options', 'createdAt']);
  const opts = obj(o.options, path + '.options', ['inGameLog']);
  return {
    gameId: bytes(matches(o.gameId, path + '.gameId', GAME_ID_RE), path + '.gameId', 16),
    configId: hex32(o.configId, path + '.configId'),
    lobbyCode: matches(o.lobbyCode, path + '.lobbyCode', LOBBY_CODE_RE),
    outcome: outcomeSchema(o.outcome, path + '.outcome'),
    missions: arr(o.missions, path + '.missions', 0, NUM_MISSIONS).map((m, i) => missionSchema(m, `${path}.missions[${i}]`)),
    players: arr(o.players, path + '.players', MIN_PLAYERS, MAX_PLAYERS).map((p, i) => {
      const pp = `${path}.players[${i}]`;
      const po = obj(p, pp, ['name', 'uid']);
      return { name: playerName(po.name, pp + '.name'), uid: pub(po.uid, pp + '.uid') };
    }),
    options: { inGameLog: bool(opts.inGameLog, path + '.options.inGameLog') },
    createdAt: int(o.createdAt, path + '.createdAt', 0, Number.MAX_SAFE_INTEGER),
  };
}

type BodySchemas = { [T in MsgType]: (v: unknown, path: string) => Bodies[T] };

const BODY: BodySchemas = {
  'lobby.create': (v, p) => {
    const o = obj(v, p, ['code', 'name', 'nonce']);
    return { code: matches(o.code, p + '.code', LOBBY_CODE_RE), name: playerName(o.name, p + '.name'), nonce: bytes(o.nonce, p + '.nonce', 16) };
  },
  'lobby.join': (v, p) => {
    const o = obj(v, p, ['name']);
    return { name: playerName(o.name, p + '.name') };
  },
  'lobby.leave': (v, p) => {
    obj(v, p, []);
    return {};
  },
  'lobby.roster': (v, p) => {
    const o = obj(v, p, ['seq', 'admin', 'members', 'rejected', 'closed']);
    return {
      seq: int(o.seq, p + '.seq', 1, Number.MAX_SAFE_INTEGER),
      admin: pub(o.admin, p + '.admin'),
      members: arr(o.members, p + '.members', 0, MAX_PLAYERS).map((m, i) => memberSchema(m, `${p}.members[${i}]`)),
      rejected: arr(o.rejected, p + '.rejected', 0, MAX_LIST).map((r, i) => {
        const rp = `${p}.rejected[${i}]`;
        const ro = obj(r, rp, ['joinId', 'reason']);
        return { joinId: hex32(ro.joinId, rp + '.joinId'), reason: oneOf(ro.reason, rp + '.reason', ['name-taken', 'invalid-name', 'full', 'game-active'] as const) };
      }),
      closed: bool(o.closed, p + '.closed'),
    };
  },
  'lobby.config': configSchema,
  key: (v, p) => {
    const o = obj(v, p, ['y', 'pok', 'seedCommit']);
    return { y: pt(o.y, p + '.y'), pok: proof(o.pok, p + '.pok'), seedCommit: hex32(o.seedCommit, p + '.seedCommit') };
  },
  shuffle: (v, p) => {
    const o = obj(v, p, ['deck', 'c', 'chat', 'proof']);
    return {
      deck: arr(o.deck, p + '.deck', MIN_PLAYERS, MAX_PLAYERS).map((c, i) => cte(c, `${p}.deck[${i}]`)),
      c: arr(o.c, p + '.c', MIN_PLAYERS, MAX_PLAYERS).map((x, i) => pt(x, `${p}.c[${i}]`)),
      chat: arr(o.chat, p + '.chat', MIN_PLAYERS, MAX_PLAYERS).map((x, i) => pt(x, `${p}.chat[${i}]`)),
      proof: proof(o.proof, p + '.proof'),
    };
  },
  deal: (v, p) => {
    const o = obj(v, p, ['d', 'proof']);
    return {
      d: arr(o.d, p + '.d', MIN_PLAYERS, MAX_PLAYERS).map((x, i) => (x === null ? null : pt(x, `${p}.d[${i}]`))),
      proof: proof(o.proof, p + '.proof'),
    };
  },
  'ot.recv': (v, p) => {
    const o = obj(v, p, ['U', 'proof']);
    return { U: pt(o.U, p + '.U'), proof: proof(o.proof, p + '.proof') };
  },
  'ot.send': (v, p) => {
    const o = obj(v, p, ['F', 'E', 'profile', 'eq', 'seed']);
    return {
      F: arr(o.F, p + '.F', 1, 16).map((c, i) => cte(c, `${p}.F[${i}]`)),
      E: arr(o.E, p + '.E', MIN_PLAYERS, MAX_PLAYERS).map((row, i) => (row === null ? null
        : arr(row, `${p}.E[${i}]`, 1, 16).map((c, r) => cte(c, `${p}.E[${i}][${r}]`)))),
      profile: proof(o.profile, p + '.profile'),
      eq: proof(o.eq, p + '.eq'),
      seed: bytes(o.seed, p + '.seed', 32),
    };
  },
  propose: (v, p) => {
    const o = obj(v, p, ['team']);
    const team = arr(o.team, p + '.team', 1, MAX_PLAYERS).map((x, i) => int(x, `${p}.team[${i}]`, 0, MAX_PLAYERS - 1));
    for (let i = 1; i < team.length; i++) if (team[i] <= team[i - 1]) fail(p + '.team', 'not strictly ascending');
    return { team };
  },
  'vote.commit': (v, p) => {
    const o = obj(v, p, ['commit']);
    return { commit: hex32(o.commit, p + '.commit') };
  },
  'vote.reveal': (v, p) => {
    const o = obj(v, p, ['approve', 'nonce']);
    return { approve: bool(o.approve, p + '.approve'), nonce: bytes(o.nonce, p + '.nonce', 32) };
  },
  ballot: (v, p) => {
    const o = obj(v, p, ['ballot', 'proof']);
    return { ballot: cte(o.ballot, p + '.ballot'), proof: proof(o.proof, p + '.proof') };
  },
  tally: (v, p) => {
    const o = obj(v, p, ['share', 'proof']);
    return { share: pt(o.share, p + '.share'), proof: proof(o.proof, p + '.proof') };
  },
  assassinate: (v, p) => {
    const o = obj(v, p, ['target', 'open', 'proof']);
    return { target: int(o.target, p + '.target', 0, MAX_PLAYERS - 1), open: pt(o.open, p + '.open'), proof: proof(o.proof, p + '.proof') };
  },
  cancel: (v, p) => {
    const o = obj(v, p, ['at', 'reason']);
    const at = str(o.at, p + '.at', 16);
    if (!isGameStepId(at)) fail(p + '.at', 'not a step id');
    return { at, reason: oneOf(o.reason, p + '.reason', ['cancel', 'leave', 'abort', 'lost'] as const) };
  },
  reveal: (v, p) => {
    const o = obj(v, p, ['x', 'ballots', 'basis']);
    const ballots = arr(o.ballots, p + '.ballots', 0, NUM_MISSIONS).map((b, i) => {
      const bp = `${p}.ballots[${i}]`;
      const bo = obj(b, bp, ['m', 'r']);
      return { m: int(bo.m, bp + '.m', 0, NUM_MISSIONS - 1), r: sc(bo.r, bp + '.r') };
    });
    for (let i = 1; i < ballots.length; i++) if (ballots[i].m <= ballots[i - 1].m) fail(p + '.ballots', 'missions not strictly ascending');
    const basis = arr(o.basis, p + '.basis', 0, MAX_LIST).map((h, i) => hex32(h, `${p}.basis[${i}]`));
    return { x: sc(o.x, p + '.x'), ballots, basis };
  },
  log: logSchema,
};

function bodyOf<T extends MsgType>(type: T, v: unknown): Bodies[T] {
  const schema: (v: unknown, path: string) => Bodies[T] = BODY[type];
  return schema(v, 'body');
}

/**
 * Strict schema validation of a decoded envelope object (§3.3). Returns a fresh,
 * typed copy; throws EnvelopeError.
 */
export function parseEnvelope(v: unknown): Envelope {
  const o = obj(v, 'envelope', ['v', 'type', 'lobby', 'game', 'step', 'author', 'prev', 't', 'body']);
  if (o.v !== 1) fail('v', 'unsupported version');
  const type = oneOf(o.type, 'type', MSG_TYPES);
  const isLobby = (LOBBY_MSG_TYPES as readonly string[]).includes(type);
  const lobby = type === 'lobby.create' ? oneOf(o.lobby, 'lobby', ['']) : hex32(o.lobby, 'lobby');
  let game: B64 | '';
  if (isLobby) game = oneOf(o.game, 'game', ['']);
  else game = bytes(matches(o.game, 'game', GAME_ID_RE), 'game', 16);
  const step = str(o.step, 'step', 16);
  if (!isStepFor(type, step)) fail('step', `malformed step id for ${type}`);
  const author = pub(o.author, 'author');
  const prev = type === 'lobby.create' || type === 'lobby.join' ? oneOf(o.prev, 'prev', ['']) : hex32(o.prev, 'prev');
  const t = int(o.t, 't', 0, Number.MAX_SAFE_INTEGER);
  const body = bodyOf(type, o.body);
  if (type === 'log' && (body as LogBundle).gameId !== game) fail('body.gameId', 'does not match the envelope game');
  return { v: 1, type, lobby, game, step, author, prev, t, body };
}
