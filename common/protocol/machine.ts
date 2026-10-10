/**
 * The game state machine (docs/p2p-protocol.md §3.5-3.7, §5): `reduceGame` is a
 * pure, order-independent function of the set of ingested envelopes of one game
 * and of the cached proof verdicts. It walks the natural chain of steps,
 * attributes faults, resolves cancels and premature reveals, and lists the
 * verification jobs needed to advance.
 *
 * The public state holds only encoded (JSON) values so that a GameEval can be
 * posted to a worker (build tasks, §7.5). Decoded points are cached by encoding.
 *
 * Caches (all keyed by content, hence sound across evaluations, seats and games):
 *  - per-message check results by msgId (a msgId binds `prev`, i.e. the whole
 *    history and the configId, so the check of a message whose `prev` matches
 *    the walk is a function of its msgId);
 *  - the state after each step by its digest D_k.
 */
import { CodecError, b64uDecode as decodeB64, b64uEncode, hexDecode, hexEncode, lp, sha256, sha512, u8, utf8 } from '../crypto/bytes.ts';
import { cardPoint, findLabel } from '../crypto/cards.ts';
import { decCt, encCt, type Ct } from '../crypto/elgamal.ts';
import { bigFromBE, CryptoError, decPoint, decScalar, encPoint, G, mulPub, O, type Point, type Scalar } from '../crypto/group.ts';
import { initialDeck, shuffleStatement } from '../crypto/shuffle.ts';
import type { Statement } from '../crypto/sigma.ts';
import {
  ballotStatement, dealStatement, openStatement, otEqStatement, otProfileStatement, otRecvStatement, pokStatement, tallyStatement,
} from '../crypto/statements.ts';
import type { B64, CardLabel, CtE, Hex32, Pt, Pub } from '../crypto/types.ts';
import {
  approvalsRequired, deriveDeck, distinctLabels, failsRequired, merlinInPlay, missionSizes, nextSeat, roleNamesInPlay, seen, teamOf,
} from './rules.ts';
import { stepOf, type StepDef } from './steps.ts';
import type { Bodies, CancelReason, Envelope, GameConfig, MsgType, StoredMsg, Verdict } from './types.ts';
import type { EncodedStatement, VerifyJob } from './jobs.ts';

// ---------------------------------------------------------------- small utilities

/** A bounded map that evicts the least recently used entry. */
export class Lru<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly max: number) {}
  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  clear(): void {
    this.map.clear();
  }
  set(k: K, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) {
      const first = this.map.keys().next();
      if (first.done !== true) this.map.delete(first.value);
    }
  }
}

const decodeCache = new Lru<string, Point>(1 << 16);

/** Cached strict point decoder; rejects the identity (§2.3). Throws CodecError. */
export function dpt(s: Pt): Point {
  const hit = decodeCache.get(s);
  if (hit !== undefined) return hit;
  const P = decPoint(s);
  decodeCache.set(s, P);
  return P;
}

const decodeAnyCache = new Lru<string, Point>(1 << 14);

/** Cached point decoder that allows the identity (computed values and statements only). */
export function dptAny(s: Pt): Point {
  const hit = decodeAnyCache.get(s);
  if (hit !== undefined) return hit;
  const P = decPoint(s, { allowIdentity: true });
  decodeAnyCache.set(s, P);
  return P;
}

export function ept(P: Point): Pt {
  return encPoint(P);
}

export function dct(c: CtE): Ct {
  return { a: dpt(c.a), b: dpt(c.b) };
}

export function ect(c: Ct): CtE {
  return encCt(c);
}

/** Sum of points (O for an empty list). */
export function sumPoints(ps: readonly Point[]): Point {
  let acc = O;
  for (const p of ps) acc = acc.add(p);
  return acc;
}

/** Encodes a statement for a worker job (§11.2 jobs.ts). */
export function encodeStatement(st: Statement): EncodedStatement {
  return {
    proofType: st.proofType,
    ctx: { configId: st.ctx.configId, stepId: st.ctx.stepId, prover: st.ctx.prover },
    aux: b64uEncode(st.aux),
    branches: st.branches.map((br) => ({
      nWitness: br.nWitness,
      eqs: br.eqs.map((eq) => ({ target: ept(eq.target), terms: eq.terms.map((t) => ({ w: t.w, base: ept(t.base) })) })),
    })),
  };
}

function compareHex(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The reveal's `basis` holds at most 256 msgIds (§3.2 list limit). */
const MAX_BASIS = 256;

function joinHex(xs: Iterable<Hex32>): Hex32[] {
  return [...new Set(xs)].sort(compareHex);
}

// ---------------------------------------------------------------- config-derived constants

export interface ConfigInfo {
  configId: Hex32;
  config: GameConfig;
  n: number;
  gameId: B64;
  seatOf: ReadonlyMap<Pub, number>;
  deck: CardLabel[];
  /** Λ: distinct labels, first-occurrence order (§5.1). */
  labels: CardLabel[];
  /** N_roles (§5.1). */
  roleNames: string[];
  labelPts: Point[];
  labelRoleIdx: number[];
  /** seenRows[λ][r] = seen(ν_r, λ.role): the sight profile of a card with label λ (§5.5). */
  seenRows: (0 | 1)[][];
  evilLabelPts: Point[];
  /** Index in Λ of every evil label, in Λ order (ballot branches 1..). */
  evilLabelIdx: number[];
  assassinLabel: CardLabel | null;
  merlin: boolean;
  initialDeck: Ct[];
  sizes: number[];
  fails: number[];
}

const configCache = new Lru<string, ConfigInfo>(64);

export function configInfo(config: GameConfig, configId: Hex32): ConfigInfo {
  const key = configId;
  const hit = configCache.get(key);
  if (hit !== undefined && hit.config === config) return hit;
  const n = config.seats.length;
  const deck = deriveDeck(n, config.selectedRoles);
  const labels = distinctLabels(deck);
  const roleNames = roleNamesInPlay(deck);
  const labelPts = labels.map((l) => cardPoint(l));
  const evilLabelIdx: number[] = [];
  labels.forEach((l, i) => {
    if (teamOf(l.role) === 'evil') evilLabelIdx.push(i);
  });
  const info: ConfigInfo = {
    configId, config, n, gameId: config.gameId,
    seatOf: new Map(config.seats.map((s, i) => [s.pub, i])),
    deck, labels, roleNames, labelPts,
    labelRoleIdx: labels.map((l) => roleNames.indexOf(l.role)),
    seenRows: labels.map((l) => roleNames.map((v): 0 | 1 => (seen(v, l.role) ? 1 : 0))),
    evilLabelPts: evilLabelIdx.map((i) => labelPts[i]),
    evilLabelIdx,
    assassinLabel: deck.find((l) => l.assassin) ?? null,
    merlin: merlinInPlay(deck),
    initialDeck: initialDeck(deck),
    sizes: missionSizes(n),
    fails: [0, 1, 2, 3, 4].map((m) => failsRequired(n, m)),
  };
  configCache.set(key, info);
  return info;
}

// ---------------------------------------------------------------- public state

export type Phase = 'SETUP' | 'TEAM_PROPOSAL' | 'PROPOSAL_VOTE' | 'MISSION_VOTE' | 'ASSASSINATION';

export type Cursor =
  | { t: 'key' } | { t: 'shuf'; j: number } | { t: 'deal' } | { t: 'otR' } | { t: 'otS' }
  | { t: 'p'; m: number; p: number } | { t: 'vc'; m: number; p: number } | { t: 'vr'; m: number; p: number }
  | { t: 'mv'; m: number } | { t: 'mt'; m: number } | { t: 'as' } | { t: 'end' };

export interface ProposalState {
  proposer: number;
  team: number[] | null;
  /** D before vc/m/p (the digest the commits bind), set when vc completes. */
  commitPrev: Hex32 | null;
  /** commits[seat], set when vc completes. */
  commits: Hex32[] | null;
  approvers: number[] | null;
  state: 'PENDING' | 'APPROVED' | 'REJECTED';
}

export interface MissionState {
  teamSize: number;
  failsRequired: number;
  proposals: ProposalState[];
  /** The approved team (seats, ascending). */
  team: number[] | null;
  /** Ballots aligned with `team`, set when mv completes. */
  ballots: CtE[] | null;
  ballotIds: Hex32[] | null;
  /** D before mv/m (the ballot randomness context, §2.5). */
  ballotPrev: Hex32 | null;
  /** T_m = Σ a. */
  T: Pt | null;
  numFails: number | null;
  state: 'PENDING' | 'SUCCESS' | 'FAIL';
}

export interface PublicState {
  n: number;
  deck: CardLabel[];
  labels: CardLabel[];
  roleNames: string[];
  merlin: boolean;
  cursor: Cursor;
  phase: Phase;
  y: Pt[] | null;
  seedCommit: Hex32[] | null;
  Y: Pt | null;
  /** decks[j] = output deck of shuf/j. */
  decks: CtE[][];
  shuffleIds: Hex32[];
  /** C_i = B_i − Σ_{j≠i} d_{j,i} (§5.4), set when deal completes. */
  C: Pt[] | null;
  U: Pt[] | null;
  F: CtE[][] | null;
  /** E[P][Q] (§5.5). */
  E: (CtE[] | null)[][] | null;
  seeds: B64[] | null;
  firstProposer: number | null;
  missions: MissionState[];
  /** Index of the current (or last) mission. */
  m: number;
  succeeded: number;
  failed: number;
  assassination: { assassin: number; target: number } | null;
  /** A natural terminal result other than an assassination. */
  result: { state: 'GOOD_WIN' | 'EVIL_WIN'; message: string } | null;
}

export function initialState(info: ConfigInfo): PublicState {
  return {
    n: info.n, deck: info.deck, labels: info.labels, roleNames: info.roleNames, merlin: info.merlin,
    cursor: { t: 'key' }, phase: 'SETUP',
    y: null, seedCommit: null, Y: null, decks: [], shuffleIds: [], C: null, U: null, F: null, E: null, seeds: null,
    firstProposer: null,
    missions: info.sizes.map((teamSize, m) => ({
      teamSize, failsRequired: info.fails[m], proposals: [], team: null, ballots: null, ballotIds: null, ballotPrev: null,
      T: null, numFails: null, state: 'PENDING',
    })),
    m: 0, succeeded: 0, failed: 0, assassination: null, result: null,
  };
}

/** The final deck's A components (after all shuffles), or null. */
export function finalA(s: PublicState): Pt[] | null {
  return s.decks.length === s.n ? s.decks[s.n - 1].map((c) => c.a) : null;
}

// ---------------------------------------------------------------- eval types

export interface Fault { seat: number; stepId: string; reason: string; evidence: Hex32[] }

export interface PendingStep {
  step: StepDef;
  /** Members of Req without a message with the right `prev` (empty at `as`). */
  missing: number[];
  /** msgIds whose verdict is needed to pass the step (including the deal gate's shuffles). */
  unverified: Hex32[];
  /** True when every verdict of earlier steps is known and valid: a seat may publish its own message. */
  gateOpen: boolean;
  /**
   * Set when the walk cannot proceed for a reason that sound proofs exclude
   * (an engine invariant or a §5.12 audit failed): nobody is blamed, nobody
   * can act, and players cancel. Diagnostic text.
   */
  stuck?: string;
}

export interface CancelInfo { msgId: Hex32; reason: CancelReason; stalled: number[]; withholding: boolean }

export interface Terminal {
  kind: 'natural' | 'canceled' | 'invalid';
  atStep: string;
  by?: number;
  faults: Fault[];
  /** §3.7 rule 3: the msgIds that make the outcome terminal. */
  basis: Hex32[];
  /** Set for kind 'canceled'. */
  cancel?: CancelInfo;
}

export interface ChainEntry { stepId: string; digest: Hex32; msgIds: Hex32[] }

export interface GameEval {
  chain: ChainEntry[];
  state: PublicState;
  /** D at the end of the natural chain (configId when empty): the `prev` of the next step. */
  head: Hex32;
  pending: PendingStep | null;
  terminal: Terminal | null;
  /** Reveals waiting for their basis (§3.7 rule 3); non-empty suspends the driver. */
  pendingReveals: Hex32[];
  jobs: VerifyJob[];
  /** Reveals by seats whose key does not match y_j (listed in cheaters, treated as missing). */
  invalidReveals: Hex32[];
  /**
   * Every shuffle of the final deck has a true verdict (the deal gate, §3.6):
   * only then are the cards well defined, so the outcome may decrypt them.
   */
  shufflesVerified: boolean;
}

// ---------------------------------------------------------------- digests

const STEP_TAG = utf8('avalon-p2p/v1/step\0');
const SEED_TAG = utf8('avalon-p2p/v1/seed\0');
const BEACON_TAG = utf8('avalon-p2p/v1/beacon\0');
const PVOTE_TAG = utf8('avalon-p2p/v1/pvote\0');

/** D_k (§3.5). */
export function stepDigest(prev: Hex32, stepId: string, msgIds: readonly Hex32[]): Hex32 {
  return hexEncode(sha256(STEP_TAG, hexDecode(prev, 32), lp(utf8(stepId)), ...msgIds.map((id) => hexDecode(id, 32))));
}

/** seedCommit (§5.2). */
export function seedCommitOf(configId: Hex32, seat: number, seed: Uint8Array): Hex32 {
  return hexEncode(sha256(SEED_TAG, hexDecode(configId, 32), u8(seat), seed));
}

/** The proposal-vote commitment (§5.8). */
export function voteCommitOf(prev: Hex32, seat: number, approve: boolean, nonce: Uint8Array): Hex32 {
  return hexEncode(sha256(PVOTE_TAG, hexDecode(prev, 32), u8(seat), u8(approve ? 1 : 0), nonce));
}

/** firstProposer (§5.5). */
export function beaconProposer(configId: Hex32, seeds: readonly Uint8Array[]): number {
  const h = sha512(BEACON_TAG, hexDecode(configId, 32), ...seeds);
  return Number(bigFromBE(h) % BigInt(seeds.length));
}

// ---------------------------------------------------------------- per-message checks

/**
 * The check of one message: valid (with its proof job), attributable failure
 * (`ok: false`, INVALID(author)), or `internal`: the engine itself failed (an
 * invariant broke), which is never attributed to the author (the walk stops,
 * stuck, and players cancel).
 */
type Checked =
  | { ok: false; reason: string }
  | { ok: 'internal'; reason: string }
  | { ok: true; job: VerifyJob | null; failReason: string; claimOk?: boolean };

const checkCache = new Lru<Hex32, Checked>(1 << 13);

function proofName(type: MsgType): string {
  switch (type) {
    case 'key': return 'key';
    case 'shuffle': return 'shuffle';
    case 'deal': return 'deal';
    case 'ot.recv': return 'ot-recv';
    case 'ot.send': return 'ot-send';
    case 'ballot': return 'ballot';
    case 'tally': return 'tally';
    case 'assassinate': return 'assassination';
    default: return type;
  }
}

function sigmaJob(id: Hex32, sts: Statement[], proofs: Bodies['key']['pok'][]): VerifyJob {
  const [first, ...rest] = sts.map(encodeStatement);
  return rest.length === 0
    ? { id, kind: 'sigma', statement: first, proofs }
    : { id, kind: 'sigma', statement: first, proofs, more: rest };
}

function requireLen<T>(xs: readonly T[], len: number, what: string): void {
  if (xs.length !== len) throw new CryptoError(`${what}: expected ${len} entries, got ${xs.length}`);
}

function need<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`internal: ${what} missing`);
  return v;
}

/** Checks one message at its step (prev already equals the walk's D). Pure in (state at prev, message). */
function checkMessage(info: ConfigInfo, s: PublicState, step: StepDef, seat: number, m: StoredMsg): Checked {
  const hit = checkCache.get(m.msgId);
  if (hit !== undefined) return hit;
  let res: Checked;
  try {
    res = checkMessageUncached(info, s, step, seat, m);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Only validation failures (malformed encodings, wrong sizes) are the author's fault.
    res = e instanceof CryptoError || e instanceof CodecError
      ? { ok: false, reason: `invalid ${proofName(m.env.type)}: ${msg}` }
      : { ok: 'internal', reason: msg.startsWith('internal:') ? msg : `internal: ${msg}` };
  }
  checkCache.set(m.msgId, res);
  return res;
}

function checkMessageUncached(info: ConfigInfo, s: PublicState, step: StepDef, seat: number, m: StoredMsg): Checked {
  const env = m.env;
  const ctx = { configId: info.configId, stepId: step.id, prover: env.author };
  const n = info.n;
  const failReason = `invalid ${proofName(env.type)} proof`;
  const y = (j: number): Point => dpt(need(s.y, 'keys')[j]);
  switch (env.type) {
    case 'key': {
      const b = env.body as Bodies['key'];
      const yj = dpt(b.y);
      return { ok: true, job: sigmaJob(m.msgId, [pokStatement(ctx, yj)], [b.pok]), failReason };
    }
    case 'shuffle': {
      const b = env.body as Bodies['shuffle'];
      requireLen(b.deck, n, 'deck');
      requireLen(b.c, n, 'c');
      requireLen(b.chat, n, 'chat');
      const out = b.deck.map((c) => decCt(c));
      const c = b.c.map(dpt);
      const chat = b.chat.map(dpt);
      const j = step.req === 'assassin' ? -1 : step.req[0];
      const input = j === 0 ? info.initialDeck : s.decks[j - 1].map(dct);
      const st = shuffleStatement(ctx, dpt(need(s.Y, 'Y')), input, out, c, chat);
      return { ok: true, job: sigmaJob(m.msgId, [st], [b.proof]), failReason };
    }
    case 'deal': {
      const b = env.body as Bodies['deal'];
      requireLen(b.d, n, 'd');
      const A = need(finalA(s), 'final deck').map(dpt);
      const d = b.d.map((x) => (x === null ? null : dpt(x)));
      const st = dealStatement(ctx, y(seat), A, d, seat);
      return { ok: true, job: sigmaJob(m.msgId, [st], [b.proof]), failReason };
    }
    case 'ot.recv': {
      const b = env.body as Bodies['ot.recv'];
      const A = dpt(need(finalA(s), 'final deck')[seat]);
      const C = dpt(need(s.C, 'C')[seat]);
      const st = otRecvStatement(ctx, y(seat), A, C, dpt(b.U), info.labelPts, info.labelRoleIdx);
      return { ok: true, job: sigmaJob(m.msgId, [st], [b.proof]), failReason };
    }
    case 'ot.send': {
      const b = env.body as Bodies['ot.send'];
      const R = info.roleNames.length;
      requireLen(b.F, R, 'F');
      requireLen(b.E, n, 'E');
      const seed = decodeB64(b.seed);
      if (seedCommitOf(info.configId, seat, seed) !== need(s.seedCommit, 'seed commits')[seat]) {
        return { ok: false, reason: 'seed' };
      }
      const F = b.F.map(dct);
      const E = b.E.map((row, Q) => {
        if (row === null) return null;
        if (Q === seat) throw new CryptoError('E: own row must be null');
        requireLen(row, R, `E[${Q}]`);
        return row.map(dct);
      });
      const A = dpt(need(finalA(s), 'final deck')[seat]);
      const C = dpt(need(s.C, 'C')[seat]);
      const U = need(s.U, 'U').map((u, Q) => (Q === seat ? null : dpt(u)));
      const profile = otProfileStatement(ctx, y(seat), A, C, F, info.labelPts, info.seenRows);
      const eq = otEqStatement(ctx, F, E, U, seat);
      return { ok: true, job: sigmaJob(m.msgId, [profile, eq], [b.profile, b.eq]), failReason };
    }
    case 'propose': {
      const b = env.body as Bodies['propose'];
      const cur = s.cursor;
      if (cur.t !== 'p') throw new Error('internal: propose outside p');
      if (b.team.length !== info.sizes[cur.m] || b.team.some((x) => x >= n)) return { ok: false, reason: 'invalid team' };
      return { ok: true, job: null, failReason };
    }
    case 'vote.commit':
      return { ok: true, job: null, failReason };
    case 'vote.reveal': {
      const b = env.body as Bodies['vote.reveal'];
      const cur = s.cursor;
      if (cur.t !== 'vr') throw new Error('internal: vote.reveal outside vr');
      const prop = s.missions[cur.m].proposals[cur.p];
      const commit = need(prop.commits, 'commits')[seat];
      if (voteCommitOf(need(prop.commitPrev, 'commit prev'), seat, b.approve, decodeB64(b.nonce)) !== commit) {
        return { ok: false, reason: 'vote reveal does not match commit' };
      }
      return { ok: true, job: null, failReason };
    }
    case 'ballot': {
      const b = env.body as Bodies['ballot'];
      const ballot = dct(b.ballot);
      const A = dpt(need(finalA(s), 'final deck')[seat]);
      const C = dpt(need(s.C, 'C')[seat]);
      const st = ballotStatement(ctx, dpt(need(s.Y, 'Y')), ballot, y(seat), A, C, info.evilLabelPts);
      return { ok: true, job: sigmaJob(m.msgId, [st], [b.proof]), failReason };
    }
    case 'tally': {
      const b = env.body as Bodies['tally'];
      const cur = s.cursor;
      if (cur.t !== 'mt') throw new Error('internal: tally outside mt');
      const T = dpt(need(s.missions[cur.m].T, 'T'));
      const st = tallyStatement(ctx, y(seat), T, dpt(b.share));
      return { ok: true, job: sigmaJob(m.msgId, [st], [b.proof]), failReason };
    }
    case 'assassinate': {
      const b = env.body as Bodies['assassinate'];
      if (b.target >= n || b.target === seat) return { ok: false, reason: 'invalid assassination target' };
      const A = dpt(need(finalA(s), 'final deck')[seat]);
      const C = dpt(need(s.C, 'C')[seat]);
      const Oa = dpt(b.open);
      const st = openStatement(ctx, y(seat), A, Oa);
      const lam = info.assassinLabel;
      const claimOk = lam !== null && C.subtract(Oa).equals(cardPoint(lam));
      return { ok: true, job: sigmaJob(m.msgId, [st], [b.proof]), failReason, claimOk };
    }
    default:
      throw new Error(`internal: unexpected message type ${env.type}`);
  }
}

// ---------------------------------------------------------------- apply

/**
 * The result of applying a completed step: the next state, attributed faults,
 * or `stuck`: an audit failure that sound proofs exclude (it indicates a bug,
 * §5.12) and that names no culprit; the walk stops there, unattributed.
 */
type Applied = { state: PublicState } | { faults: Fault[] } | { stuck: string };

const applyCache = new Lru<Hex32, Applied>(1 << 13);

function withMission(s: PublicState, m: number, f: (ms: MissionState) => MissionState): MissionState[] {
  const out = s.missions.slice();
  out[m] = f(s.missions[m]);
  return out;
}

function withProposal(ms: MissionState, p: number, f: (pr: ProposalState) => ProposalState): MissionState {
  const proposals = ms.proposals.slice();
  proposals[p] = f(ms.proposals[p]);
  return { ...ms, proposals };
}

function newProposal(proposer: number): ProposalState {
  return { proposer, team: null, commitPrev: null, commits: null, approvers: null, state: 'PENDING' };
}

/** Minimal subsets of `pts` (by size) whose sum is the identity. */
function zeroSubsets(pts: readonly Point[]): number[][] {
  const t = pts.length;
  for (let size = 2; size <= t; size++) {
    const found: number[][] = [];
    const rec = (start: number, chosen: number[], acc: Point): void => {
      if (chosen.length === size) {
        if (acc.is0()) found.push([...chosen]);
        return;
      }
      for (let i = start; i < t; i++) rec(i + 1, [...chosen, i], acc.add(pts[i]));
    };
    rec(0, [], O);
    if (found.length > 0) return found;
  }
  return [];
}

/** Applies a completed step. `msgs[i]` is the message of `ids` order (Req seats ascending). */
function apply(info: ConfigInfo, s: PublicState, step: StepDef, seats: number[], msgs: StoredMsg[], D: Hex32): Applied {
  const n = info.n;
  const cur = s.cursor;
  const fault = (seat: number, reason: string, evidence: Hex32[]): Fault => ({ seat, stepId: step.id, reason, evidence: joinHex(evidence) });
  switch (cur.t) {
    case 'key': {
      const ys = msgs.map((m) => (m.env.body as Bodies['key']).y);
      const faults: Fault[] = [];
      for (let j = 0; j < n; j++) {
        const i = ys.indexOf(ys[j]);
        if (i < j) faults.push(fault(j, 'duplicate key', [msgs[j].msgId, msgs[i].msgId]));
      }
      if (faults.length > 0) return { faults };
      const Y = sumPoints(ys.map(dpt));
      // Every y_j has a proof of knowledge, so no seat can force Y = O: a bug, not a fault.
      if (Y.is0()) return { stuck: 'audit: joint key is the identity' };
      return {
        state: {
          ...s, y: ys, seedCommit: msgs.map((m) => (m.env.body as Bodies['key']).seedCommit), Y: ept(Y),
          cursor: { t: 'shuf', j: 0 },
        },
      };
    }
    case 'shuf': {
      const deck = (msgs[0].env.body as Bodies['shuffle']).deck;
      return {
        state: {
          ...s, decks: [...s.decks, deck], shuffleIds: [...s.shuffleIds, msgs[0].msgId],
          cursor: cur.j + 1 < n ? { t: 'shuf', j: cur.j + 1 } : { t: 'deal' },
        },
      };
    }
    case 'deal': {
      const deck = s.decks[n - 1];
      const shares = msgs.map((m) => (m.env.body as Bodies['deal']).d);
      const C: Pt[] = [];
      for (let i = 0; i < n; i++) {
        let Ci = dpt(deck[i].b);
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          const d = shares[j][i];
          if (d === null) throw new Error('internal: null share');
          Ci = Ci.subtract(dpt(d));
        }
        C.push(ept(Ci));
      }
      return { state: { ...s, C, cursor: { t: 'otR' } } };
    }
    case 'otR':
      return { state: { ...s, U: msgs.map((m) => (m.env.body as Bodies['ot.recv']).U), cursor: { t: 'otS' } } };
    case 'otS': {
      const bodies = msgs.map((m) => m.env.body as Bodies['ot.send']);
      const seeds = bodies.map((b) => b.seed);
      const fp = beaconProposer(info.configId, seeds.map((x) => decodeB64(x)));
      const missions = withMission(s, 0, (ms) => ({ ...ms, proposals: [newProposal(fp)] }));
      return {
        state: {
          ...s, F: bodies.map((b) => b.F), E: bodies.map((b) => b.E), seeds, firstProposer: fp, missions,
          phase: 'TEAM_PROPOSAL', cursor: { t: 'p', m: 0, p: 0 },
        },
      };
    }
    case 'p': {
      const team = (msgs[0].env.body as Bodies['propose']).team;
      return {
        state: {
          ...s, missions: withMission(s, cur.m, (ms) => withProposal(ms, cur.p, (pr) => ({ ...pr, team: [...team] }))),
          phase: 'PROPOSAL_VOTE', cursor: { t: 'vc', m: cur.m, p: cur.p },
        },
      };
    }
    case 'vc': {
      const commits = msgs.map((m) => (m.env.body as Bodies['vote.commit']).commit);
      return {
        state: {
          ...s, missions: withMission(s, cur.m, (ms) => withProposal(ms, cur.p, (pr) => ({ ...pr, commits, commitPrev: D }))),
          cursor: { t: 'vr', m: cur.m, p: cur.p },
        },
      };
    }
    case 'vr': {
      const approvers = seats.filter((_, i) => (msgs[i].env.body as Bodies['vote.reveal']).approve);
      const approved = approvers.length >= approvalsRequired(n);
      const prop = s.missions[cur.m].proposals[cur.p];
      if (approved) {
        return {
          state: {
            ...s,
            missions: withMission(s, cur.m, (ms) => ({
              ...withProposal(ms, cur.p, (pr) => ({ ...pr, approvers, state: 'APPROVED' })), team: prop.team,
            })),
            phase: 'MISSION_VOTE', cursor: { t: 'mv', m: cur.m },
          },
        };
      }
      const rejected = withMission(s, cur.m, (ms) => withProposal(ms, cur.p, (pr) => ({ ...pr, approvers, state: 'REJECTED' })));
      if (cur.p === 4) {
        return {
          state: {
            ...s, missions: rejected, cursor: { t: 'end' },
            result: { state: 'EVIL_WIN', message: 'Five team proposals in a row rejected' },
          },
        };
      }
      const next = newProposal(nextSeat(prop.proposer, n));
      return {
        state: {
          ...s,
          missions: rejected.map((ms, i) => (i === cur.m ? { ...ms, proposals: [...ms.proposals, next] } : ms)),
          phase: 'TEAM_PROPOSAL', cursor: { t: 'p', m: cur.m, p: cur.p + 1 },
        },
      };
    }
    case 'mv': {
      const ballots = msgs.map((m) => (m.env.body as Bodies['ballot']).ballot);
      const faults: Fault[] = [];
      for (let j = 0; j < ballots.length; j++) {
        const i = ballots.findIndex((b) => b.a === ballots[j].a);
        if (i < j) faults.push(fault(seats[j], 'duplicate ballot', [msgs[j].msgId, msgs[i].msgId]));
      }
      if (faults.length > 0) return { faults };
      const as = ballots.map((b) => dpt(b.a));
      const T = sumPoints(as);
      if (T.is0()) {
        const subsets = zeroSubsets(as);
        const members = [...new Set(subsets.flat())].sort((a, b) => a - b);
        const evidence = members.map((i) => msgs[i].msgId);
        return { faults: members.map((i) => fault(seats[i], 'ballots cancel out', evidence)) };
      }
      return {
        state: {
          ...s,
          missions: withMission(s, cur.m, (ms) => ({ ...ms, ballots, ballotIds: msgs.map((m) => m.msgId), ballotPrev: D, T: ept(T) })),
          cursor: { t: 'mt', m: cur.m },
        },
      };
    }
    case 'mt': {
      const ms = s.missions[cur.m];
      const ballots = need(ms.ballots, 'ballots');
      const W = sumPoints(ballots.map((b) => dpt(b.b))).subtract(sumPoints(msgs.map((m) => dpt((m.env.body as Bodies['tally']).share))));
      const k = smallLogPub(W, ms.teamSize);
      // Ballot and tally proofs make the tally decrypt: a failure is a bug, never a seat's fault (§5.12).
      if (k === null) return { stuck: 'audit: tally does not decrypt' };
      const failed = k >= ms.failsRequired;
      const succeeded = s.succeeded + (failed ? 0 : 1);
      const failedN = s.failed + (failed ? 1 : 0);
      const missions = withMission(s, cur.m, (x) => ({ ...x, numFails: k, state: failed ? 'FAIL' : 'SUCCESS' }));
      const base = { ...s, missions, succeeded, failed: failedN };
      if (failedN === 3) return { state: { ...base, cursor: { t: 'end' }, result: { state: 'EVIL_WIN', message: 'Three failed missions' } } };
      if (succeeded === 3) {
        if (info.merlin) return { state: { ...base, phase: 'ASSASSINATION', cursor: { t: 'as' } } };
        return { state: { ...base, cursor: { t: 'end' }, result: { state: 'GOOD_WIN', message: 'Three missions succeeded' } } };
      }
      const approvedProposal = ms.proposals[ms.proposals.length - 1];
      const nm = cur.m + 1;
      const next = newProposal(nextSeat(approvedProposal.proposer, n));
      return {
        state: {
          ...base, m: nm, missions: missions.map((x, i) => (i === nm ? { ...x, proposals: [next] } : x)),
          phase: 'TEAM_PROPOSAL', cursor: { t: 'p', m: nm, p: 0 },
        },
      };
    }
    case 'as': {
      const target = (msgs[0].env.body as Bodies['assassinate']).target;
      return { state: { ...s, assassination: { assassin: seats[0], target }, cursor: { t: 'end' } } };
    }
    case 'end':
      throw new Error('internal: apply at end');
  }
}

function smallLogPub(P: Point, max: number): number | null {
  let Q = O;
  for (let k = 0; k <= max; k++) {
    if (Q.equals(P)) return k;
    Q = Q.add(G);
  }
  return null;
}

// ---------------------------------------------------------------- reveals

const revealKeyCache = new Lru<string, boolean>(1 << 12);

/** x·G = y_j for a reveal (§5.12); false for anything malformed. */
export function revealKeyOk(m: StoredMsg, yj: Pt): boolean {
  const k = m.msgId + '/' + yj;
  const hit = revealKeyCache.get(k);
  if (hit !== undefined) return hit;
  let ok: boolean;
  try {
    const x = decScalar((m.env.body as Bodies['reveal']).x);
    ok = x !== 0n && mulPub(G, x).equals(dpt(yj));
  } catch {
    ok = false;
  }
  revealKeyCache.set(k, ok);
  return ok;
}

/** The scalar of a reveal (caller checked revealKeyOk). */
export function revealScalar(m: StoredMsg): Scalar {
  return decScalar((m.env.body as Bodies['reveal']).x);
}

// ---------------------------------------------------------------- reduce

export interface ReduceInput {
  config: GameConfig;
  configId: Hex32;
  /** The lobby of the config (§4.6): only configs of this lobby can conflict. Addition to §11.2. */
  lobbyId: Hex32;
  msgs: ReadonlyMap<Hex32, StoredMsg>;
  verdicts: ReadonlyMap<Hex32, Verdict>;
  /** Other lobby.config envelopes with this gameId (§4.6). */
  conflictingConfigs: readonly StoredMsg[];
  /**
   * Author of this config (the admin). Config equivocation is two configs of
   * one gameId signed by this author; configs by anybody else are ignored.
   * Addition to §11.2.
   */
  configAuthor: Pub;
}

interface WalkStop {
  kind: 'natural' | 'invalid' | 'pending';
  step: StepDef | null;
  faults: Fault[];
  pending: PendingStep | null;
}

type GameMsg = StoredMsg & { env: Envelope };

function isStepped(type: MsgType): boolean {
  return type !== 'cancel' && type !== 'reveal' && type !== 'log'
    && type !== 'lobby.create' && type !== 'lobby.join' && type !== 'lobby.leave' && type !== 'lobby.roster' && type !== 'lobby.config';
}

/** §3.6-3.7: evaluates one game. */
export function reduceGame(input: ReduceInput): GameEval {
  const { config, configId, verdicts } = input;
  const info = configInfo(config, configId);

  // Index the game's messages by step; authors must be seats.
  const byStep = new Map<string, GameMsg[]>();
  const cancels: GameMsg[] = [];
  const reveals: GameMsg[] = [];
  for (const m of input.msgs.values()) {
    if (m.env.game !== config.gameId) continue;
    if (!info.seatOf.has(m.env.author)) continue;
    if (m.env.type === 'cancel') cancels.push(m);
    else if (m.env.type === 'reveal') reveals.push(m);
    else if (isStepped(m.env.type)) {
      const list = byStep.get(m.env.step);
      if (list === undefined) byStep.set(m.env.step, [m]);
      else list.push(m);
    }
  }
  const seatOf = (m: StoredMsg): number => info.seatOf.get(m.env.author) as number;

  // ------------------------------------------------------------ natural walk
  let state = initialState(info);
  let D: Hex32 = configId;
  const chain: ChainEntry[] = [];
  const before: PublicState[] = [];
  const steps: StepDef[] = [];
  const jobs = new Map<Hex32, VerifyJob>();
  let stop: WalkStop;
  const stuckAt = (step: StepDef, reason: string): WalkStop => ({
    kind: 'pending', step, faults: [], pending: { step, missing: [], unverified: [], gateOpen: false, stuck: reason },
  });

  for (;;) {
    const step = stepOf(state.cursor, state);
    if (step === null) {
      stop = { kind: 'natural', step: null, faults: [], pending: null };
      break;
    }
    const M = (byStep.get(step.id) ?? []).filter((m) => m.env.type === step.type);
    const bySeat = new Map<number, GameMsg[]>();
    for (const m of M) {
      const seat = seatOf(m);
      const l = bySeat.get(seat);
      if (l === undefined) bySeat.set(seat, [m]);
      else l.push(m);
    }
    const reqSeats = step.req === 'assassin' ? [...bySeat.keys()].sort((a, b) => a - b) : step.req;
    const faults: Fault[] = [];
    const present = new Map<number, { m: GameMsg; c: Checked & { ok: true } }>();
    const unverified: Hex32[] = [];
    let stuck: string | null = null;
    for (const seat of reqSeats) {
      const ms = bySeat.get(seat) ?? [];
      if (ms.length >= 2) {
        // Two messages prove the fault; citing every one would let a mass equivocator exceed the
        // reveal's 256-entry basis and block every honest reveal.
        faults.push({ seat, stepId: step.id, reason: 'equivocation', evidence: joinHex(ms.map((m) => m.msgId)).slice(0, 2) });
        continue;
      }
      if (ms.length === 0) continue;
      const m = ms[0];
      if (m.env.prev !== D) continue;
      const c = checkMessage(info, state, step, seat, m);
      if (c.ok === 'internal') {
        stuck ??= c.reason;
        continue;
      }
      if (!c.ok) {
        faults.push({ seat, stepId: step.id, reason: c.reason, evidence: [m.msgId] });
        continue;
      }
      if (c.job !== null) {
        const v = verdicts.get(m.msgId);
        if (v === undefined) {
          unverified.push(m.msgId);
          jobs.set(m.msgId, c.job);
        } else if (!v.ok) {
          faults.push({ seat, stepId: step.id, reason: c.failReason, evidence: [m.msgId] });
          continue;
        } else if (c.claimOk === false) {
          faults.push({ seat, stepId: step.id, reason: 'false assassination claim', evidence: [m.msgId] });
          continue;
        }
      }
      present.set(seat, { m, c });
    }
    if (faults.length > 0) {
      stop = { kind: 'invalid', step, faults, pending: null };
      break;
    }
    if (stuck !== null) {
      stop = stuckAt(step, stuck);
      break;
    }
    // The deal gate (§3.6 pipelining): every shuffle proof verified.
    const gateUnverified: Hex32[] = [];
    if (step.type === 'deal') {
      for (const id of state.shuffleIds) {
        const v = verdicts.get(id);
        if (v === undefined) gateUnverified.push(id);
      }
    }
    let doneSeats: number[];
    let complete: boolean;
    let missing: number[];
    if (step.req === 'assassin') {
      missing = [];
      const winner = [...present.entries()].find(([, x]) => !unverified.includes(x.m.msgId) && x.c.claimOk === true);
      complete = winner !== undefined && unverified.length === 0;
      doneSeats = winner === undefined ? [] : [winner[0]];
    } else {
      missing = step.req.filter((seat) => !present.has(seat));
      // A shuffle is structurally complete before its verdict (pipelining).
      const blocking = step.type === 'shuffle' ? [] : unverified;
      complete = missing.length === 0 && blocking.length === 0 && gateUnverified.length === 0;
      doneSeats = step.req;
    }
    if (!complete) {
      stop = {
        kind: 'pending', step, faults: [],
        pending: { step, missing, unverified: [...gateUnverified, ...unverified], gateOpen: gateUnverified.length === 0 },
      };
      break;
    }
    const stepMsgs = doneSeats.map((seat) => (present.get(seat) as { m: GameMsg }).m);
    const ids = stepMsgs.map((m) => m.msgId);
    const Dk = stepDigest(D, step.id, ids);
    let applied = applyCache.get(Dk);
    if (applied === undefined) {
      try {
        applied = apply(info, state, step, doneSeats, stepMsgs, D);
      } catch (e) {
        // Messages that passed their checks cannot make apply throw: an engine bug, never attributed.
        applied = { stuck: `internal: ${e instanceof Error ? e.message : String(e)}` };
      }
      applyCache.set(Dk, applied);
    }
    if ('faults' in applied) {
      stop = { kind: 'invalid', step, faults: applied.faults, pending: null };
      break;
    }
    if ('stuck' in applied) {
      stop = stuckAt(step, applied.stuck);
      break;
    }
    before.push(state);
    steps.push(step);
    chain.push({ stepId: step.id, digest: Dk, msgIds: ids });
    state = applied.state;
    D = Dk;
  }

  // ------------------------------------------------------------ positions on the chain
  const digestPos = new Map<Hex32, number>([[configId, 0]]);
  chain.forEach((c, i) => digestPos.set(c.digest, i + 1));
  const stepAt = (p: number): StepDef | null => (p < steps.length ? steps[p] : p === chain.length ? stop.step : null);
  const stateAt = (p: number): PublicState | null => (p < before.length ? before[p] : p === chain.length ? state : null);
  const digestBefore = (p: number): Hex32 => (p === 0 ? configId : chain[p - 1].digest);

  /** Natural-chain position of a stepped message (its prev on the chain and its step the one after), or null. */
  const posOf = (m: StoredMsg): number | null => {
    const p = digestPos.get(m.env.prev);
    if (p === undefined) return null;
    const st = stepAt(p);
    return st !== null && st.id === m.env.step && st.type === m.env.type ? p : null;
  };

  // ------------------------------------------------------------ events (§3.7 rule 4)
  interface InvalidEvent { index: number; faults: Fault[] }
  interface CancelEvent { index: number; seat: number; m: GameMsg }
  const invalids: InvalidEvent[] = [];
  const validCancels: CancelEvent[] = [];
  if (stop.kind === 'invalid') invalids.push({ index: chain.length, faults: stop.faults });

  // Config equivocation (§4.6): two configs of this gameId and lobby signed by the config's own author.
  // A config by anybody else (another seat, an outsider: lobby souls are writable by anyone) proves
  // nothing about the admin and is ignored; keys naming it as prev are merely absent (§3.6).
  const conflicting = input.conflictingConfigs.filter((c) => c.msgId !== configId && c.env.type === 'lobby.config'
    && c.env.author === input.configAuthor && c.env.lobby === input.lobbyId
    && (c.env.body as GameConfig).gameId === config.gameId);
  const adminSeat = info.seatOf.get(input.configAuthor);
  if (conflicting.length > 0 && adminSeat !== undefined) {
    // This config and the lowest other one prove the equivocation (bounded, like step equivocation).
    const evidence = joinHex([configId, joinHex(conflicting.map((c) => c.msgId))[0]]);
    invalids.push({ index: 0, faults: [{ seat: adminSeat, stepId: 'key', reason: 'config equivocation', evidence }] });
  }

  // Continuations: stepped messages on the natural chain, per seat.
  const contBySeat = new Map<number, { p: number; msgId: Hex32 }[]>();
  for (const list of byStep.values()) {
    for (const m of list) {
      const p = posOf(m);
      if (p === null) continue;
      const seat = seatOf(m);
      const l = contBySeat.get(seat);
      if (l === undefined) contBySeat.set(seat, [{ p, msgId: m.msgId }]);
      else l.push({ p, msgId: m.msgId });
    }
  }

  for (const c of cancels) {
    const body = c.env.body as Bodies['cancel'];
    const p = digestPos.get(c.env.prev);
    if (p === undefined) continue;
    const st = stepAt(p);
    const sBefore = stateAt(p);
    if (st === null || sBefore === null || st.id !== body.at) continue;
    if (sBefore.phase === 'ASSASSINATION' || st.kind === 'assassination') continue;   // rule 6
    const X = seatOf(c);
    // Rule 2: canceled and continued.
    const later = (contBySeat.get(X) ?? []).filter((x) => x.p > p).sort((a, b) => a.p - b.p || compareHex(a.msgId, b.msgId));
    if (later.length > 0) {
      invalids.push({ index: p, faults: [{ seat: X, stepId: st.id, reason: 'canceled and continued', evidence: joinHex([c.msgId, later[0].msgId]) }] });
      continue;
    }
    // Rule 2a: no contributor cancel at the mt/m before a possible assassination.
    if (st.type === 'tally' && sBefore.succeeded === 2 && info.merlin) {
      const own = (byStep.get(st.id) ?? []).find((m) => m.env.type === 'tally' && seatOf(m) === X && m.env.prev === digestBefore(p));
      if (own !== undefined) {
        invalids.push({ index: p, faults: [{ seat: X, stepId: st.id, reason: 'canceled and continued', evidence: joinHex([c.msgId, own.msgId]) }] });
        continue;
      }
    }
    validCancels.push({ index: p, seat: X, m: c });
  }

  // ------------------------------------------------------------ reveals (§3.7 rule 3)
  // Judged whenever the natural walk is pending, before the rule-4 resolution, so that a premature
  // reveal is an INVALID event at the pending step like any other (and beats a cancel at that step).
  const revealPending: Hex32[] = [];
  const invalidReveals: Hex32[] = [];
  const keyKnown = state.y !== null;
  if (keyKnown) {
    for (const r of reveals) if (!revealKeyOk(r, (state.y as Pt[])[seatOf(r)])) invalidReveals.push(r.msgId);
  }
  if (keyKnown && stop.kind === 'pending' && stop.step !== null) {
    // A reveal citing a valid cancel or the evidence of an INVALID event is an ordinary end-of-game reveal.
    const justifying = new Set<Hex32>(validCancels.map((c) => c.m.msgId));
    for (const e of invalids) for (const f of e.faults) for (const id of f.evidence) justifying.add(id);
    const conflictingIds = new Set(conflicting.map((c) => c.msgId));
    const revealIds = new Set(reveals.map((r) => r.msgId));
    const validKey = reveals.filter((r) => !invalidReveals.includes(r.msgId));
    const status = new Map<Hex32, { pending: boolean; justified: boolean; cites: Hex32[] }>();
    for (const r of validKey) {
      const body = r.env.body as Bodies['reveal'];
      let pending = false;
      let justified = false;
      const cites: Hex32[] = [];
      for (const b of body.basis) {
        if (justifying.has(b)) justified = true;
        if (b === configId || conflictingIds.has(b)) continue;
        if (revealIds.has(b)) {
          cites.push(b);
          continue;
        }
        const m = input.msgs.get(b);
        if (m === undefined || m.env.game !== config.gameId || !info.seatOf.has(m.env.author)) {
          pending = true;
          break;
        }
        if (m.env.type === 'cancel') {
          const p = digestPos.get(m.env.prev);
          if (p === undefined || stepAt(p) === null) pending = true;
          continue;
        }
        if (!isStepped(m.env.type)) {
          pending = true;
          break;
        }
        const p = posOf(m);
        // At the pending step itself, a basis message is still being evaluated while a verdict needed
        // there is unknown (e.g. an extra, unverified claim at `as`): pending, not premature.
        if (p === null || (p === chain.length && stop.pending !== null && stop.pending.unverified.length > 0)) {
          pending = true;
          break;
        }
        const sAt = stateAt(p);
        const stAt = stepAt(p);
        if (sAt === null || stAt === null) {
          pending = true;
          break;
        }
        const c = checkMessage(info, sAt, stAt, seatOf(m), m);
        if (c.ok === true && c.job !== null && !verdicts.has(m.msgId)) {
          jobs.set(m.msgId, c.job);
          pending = true;
          break;
        }
      }
      status.set(r.msgId, { pending, justified, cites });
    }
    // A reveal citing a pending or unknown reveal is pending too.
    let changed = true;
    while (changed) {
      changed = false;
      for (const st of status.values()) {
        if (st.pending) continue;
        if (st.cites.some((c) => status.get(c)?.pending !== false)) {
          st.pending = true;
          changed = true;
        }
      }
    }
    const cand = [...status.entries()].filter(([, st]) => !st.pending && !st.justified);
    const okIds = new Set([...status.entries()].filter(([, st]) => !st.pending && st.justified).map(([id]) => id));
    const grounded = cand.filter(([, st]) => st.cites.length === 0).map(([id]) => id);
    for (const id of grounded) okIds.add(id);
    const cyclic = cand.filter(([, st]) => st.cites.length > 0 && !st.cites.some((c) => okIds.has(c))).map(([id]) => id);
    const blamed = grounded.length > 0 ? grounded : cyclic;
    if (blamed.length > 0) {
      const stepId = stop.step.id;
      const faults = blamed
        .map((id) => input.msgs.get(id) as StoredMsg)
        .map((r) => ({ seat: seatOf(r), stepId, reason: 'revealed key during the game', evidence: [r.msgId] }));
      invalids.push({ index: chain.length, faults });
    }
    for (const [id, st] of status) if (st.pending) revealPending.push(id);
  }

  // ------------------------------------------------------------ resolution (§3.7 rules 4-5)
  const naturalIndex = stop.kind === 'natural' ? chain.length - 1 : null;
  let minIndex = Number.MAX_SAFE_INTEGER;
  for (const e of invalids) minIndex = Math.min(minIndex, e.index);
  for (const e of validCancels) minIndex = Math.min(minIndex, e.index);
  if (naturalIndex !== null) minIndex = Math.min(minIndex, naturalIndex);

  let terminal: Terminal | null = null;
  if (minIndex !== Number.MAX_SAFE_INTEGER) {
    const inv = invalids.filter((e) => e.index === minIndex);
    if (inv.length > 0) {
      terminal = invalidTerminal(inv.flatMap((e) => e.faults), stepAt(minIndex)?.id ?? 'key');
    } else {
      const canc = validCancels.filter((e) => e.index === minIndex).sort((a, b) => a.seat - b.seat || compareHex(a.m.msgId, b.m.msgId));
      const st = stepAt(minIndex);
      if (canc.length > 0 && !(naturalIndex === minIndex && st !== null && st.kind === 'automatic')) {
        const c = canc[0];
        const stalled = minIndex === chain.length && stop.pending !== null ? [...stop.pending.missing] : [];
        terminal = {
          kind: 'canceled', atStep: (st as StepDef).id, by: c.seat, faults: [], basis: [c.m.msgId],
          cancel: {
            msgId: c.m.msgId, reason: (c.m.env.body as Bodies['cancel']).reason, stalled,
            withholding: (st as StepDef).kind === 'automatic' && stalled.includes(c.seat),
          },
        };
      } else if (naturalIndex !== null) {
        const last = chain[naturalIndex];
        terminal = { kind: 'natural', atStep: last.stepId, faults: [], basis: [...last.msgIds] };
      }
    }
  }

  const n = info.n;
  const shufflesVerified = state.shuffleIds.length === n && state.shuffleIds.every((id) => verdicts.get(id)?.ok === true);
  return {
    chain, state, head: D,
    pending: stop.pending,
    terminal,
    // While terminal, nothing is suspended: the driver only reveals (§3.7 rule 3).
    pendingReveals: terminal === null ? revealPending.sort(compareHex) : [],
    jobs: [...jobs.values()],
    invalidReveals: invalidReveals.sort(compareHex),
    shufflesVerified,
  };
}

/** Clears the content-keyed caches (tests: exercise the uncached paths in different orders). */
export function resetMachineCaches(): void {
  checkCache.clear();
  applyCache.clear();
  revealKeyCache.clear();
  configCache.clear();
}

function invalidTerminal(faults: Fault[], atStep: string): Terminal {
  // One fault per (seat, reason); sorted by seat.
  const seenKey = new Set<string>();
  const uniq: Fault[] = [];
  for (const f of [...faults].sort((a, b) => a.seat - b.seat || compareHex(a.evidence[0] ?? '', b.evidence[0] ?? ''))) {
    const k = f.seat + '/' + f.reason;
    if (seenKey.has(k)) continue;
    seenKey.add(k);
    uniq.push(f);
  }
  const basis = joinHex(uniq.flatMap((f) => f.evidence));
  // Every fault cites at most two messages (ballots cancelling out: at most the team, shared), and there
  // is one fault per (seat, reason), so the basis stays far below the reveal's 256-entry limit. Should
  // it ever exceed it, any cited msgId justifies a reveal (§3.7 rule 3), so a prefix keeps reveals valid.
  return { kind: 'invalid', atStep, by: uniq[0].seat, faults: uniq, basis: basis.slice(0, MAX_BASIS) };
}

// ---------------------------------------------------------------- helpers for other modules

/** Seat of a pub in the config, or -1. */
export function seatIndex(config: GameConfig, pub: Pub): number {
  return config.seats.findIndex((s) => s.pub === pub);
}

/** Valid vote reveals at the pending vr step (rule 5a): approve flags by seat, or null if not pending at vr. */
export function pendingVoteReveals(config: GameConfig, ev: GameEval, msgs: ReadonlyMap<Hex32, StoredMsg>): Map<number, boolean> | null {
  const cur = ev.state.cursor;
  if (cur.t !== 'vr') return null;
  const prop = ev.state.missions[cur.m].proposals[cur.p];
  const out = new Map<number, boolean>();
  const stepId = `vr/${cur.m}/${cur.p}`;
  const counts = new Map<number, number>();
  for (const m of msgs.values()) {
    if (m.env.game !== config.gameId || m.env.type !== 'vote.reveal' || m.env.step !== stepId || m.env.prev !== ev.head) continue;
    const seat = seatIndex(config, m.env.author);
    if (seat < 0) continue;
    counts.set(seat, (counts.get(seat) ?? 0) + 1);
    const b = m.env.body as Bodies['vote.reveal'];
    const commit = prop.commits?.[seat];
    if (commit === undefined || prop.commitPrev === null) continue;
    if (voteCommitOf(prop.commitPrev, seat, b.approve, decodeB64(b.nonce)) === commit) out.set(seat, b.approve);
  }
  for (const [seat, c] of counts) if (c > 1) out.delete(seat);
  return out;
}

/** The label of a decrypted card point, or null. */
export function labelOfPoint(P: Point, labels: readonly CardLabel[]): CardLabel | null {
  return findLabel(P, labels);
}
