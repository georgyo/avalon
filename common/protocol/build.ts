/**
 * Message builders (docs/p2p-protocol.md §5, §11.2). The only module that
 * publishes multiples of x_j (§5.11 allow-list: `deal`, `tally`, `assassinate`
 * openings and the end-of-game `reveal`). Each builder returns an unsigned
 * envelope; the driver signs it and commits it to the once-only journal (§3.9)
 * before putting it.
 *
 * Every builder is deterministic in (gs_j, the public state, the user's
 * choice): republishing after a reload yields byte-identical envelopes (§2.5).
 *
 * Addition to §11.2: `BuildCtx.lobbyId` (every game envelope carries the
 * lobbyId in its `lobby` field, §3.2, which the §11.2 BuildCtx omitted).
 */
import { b64uEncode, hexDecode } from '../crypto/bytes.ts';
import { ballotRandomness, deriveStream, type SeedRef } from '../crypto/derive.ts';
import { encryptBit } from '../crypto/elgamal.ts';
import { cardPoint } from '../crypto/cards.ts';
import { G, mul, type Point, type Scalar } from '../crypto/group.ts';
import { otChoice, otSenderMessages } from '../crypto/ot.ts';
import { initialDeck, proveShuffle } from '../crypto/shuffle.ts';
import { proveSigma } from '../crypto/sigma.ts';
import {
  ballotStatement, dealStatement, openStatement, otEqStatement, otProfileStatement, otRecvStatement, pokStatement, tallyStatement,
} from '../crypto/statements.ts';
import { encScalar } from '../crypto/group.ts';
import type { Hex32, Pub } from '../crypto/types.ts';
import { configInfo, dct, dpt, ect, ept, finalA, voteCommitOf, seedCommitOf, type GameEval } from './machine.ts';
import { beaconSeed, otBeta, secretKey, seedRefOf, type GameSecrets, type PrivateView } from './private.ts';
import { projectGame } from './project.ts';
import { teamOf } from './rules.ts';
import type { StepDef } from './steps.ts';
import type { Bodies, CancelReason, Envelope, GameConfig, GameMsgType, LogBundle } from './types.ts';
import type { GameOutcome } from './views.ts';

export interface BuildCtx {
  config: GameConfig;
  configId: Hex32;
  /** Addition to §11.2: the lobbyId every game envelope carries (§3.2). */
  lobbyId: Hex32;
  seat: number;
  me: Pub;
  ev: GameEval;
  /** Null for a device that lost its game record (§3.10): only buildCancel accepts that. */
  secrets: GameSecrets | null;
  priv: PrivateView | null;
  now: number;
}

function toT(now: number): number {
  if (!Number.isFinite(now) || now < 0) return 0;
  return Math.trunc(now);
}

function envelope<T extends GameMsgType | 'log'>(ctx: BuildCtx, type: T, step: string, prev: Hex32, body: Bodies[T]): Envelope<T> {
  return { v: 1, type, lobby: ctx.lobbyId, game: ctx.config.gameId, step, author: ctx.me, prev, t: toT(ctx.now), body };
}

/** The game secrets; every builder but buildCancel needs them (§3.10: a lost record never regenerates x_j). */
function secretsOf(ctx: BuildCtx): GameSecrets {
  if (ctx.secrets === null) throw new Error('This browser lost the secret keys for this game');
  return ctx.secrets;
}

/**
 * Defense in depth (§5.11): every builder of a step message runs only for the
 * running game's pending step whose gate is open (every earlier verdict known
 * and valid), and never while a reveal is pending (the driver is suspended,
 * §3.7 rule 3).
 */
function requireRunning(ctx: BuildCtx): NonNullable<GameEval['pending']> {
  const p = ctx.ev.pending;
  if (ctx.ev.terminal !== null || p === null) throw new Error('The game is not running');
  if (ctx.ev.pendingReveals.length > 0) throw new Error('Suspended: a reveal is pending');
  if (!p.gateOpen) throw new Error(`Gate closed at ${p.step.id}: earlier verdicts unknown`);
  return p;
}

/** The pending step, which must have type `type` and require this seat. */
function pendingStep(ctx: BuildCtx, type: GameMsgType): StepDef {
  const p = requireRunning(ctx);
  if (p.step.type !== type) throw new Error(`Not at a ${type} step (pending: ${p.step.id})`);
  if (p.step.req !== 'assassin' && !p.step.req.includes(ctx.seat)) throw new Error(`Seat ${ctx.seat} is not required at ${p.step.id}`);
  return p.step;
}

function proofCtx(ctx: BuildCtx, stepId: string): { configId: Hex32; stepId: string; prover: Pub } {
  return { configId: ctx.configId, stepId, prover: ctx.me };
}

function seed(ctx: BuildCtx): SeedRef {
  return seedRefOf(ctx.config, secretsOf(ctx));
}

function y(ctx: BuildCtx, j: number): Point {
  const ys = ctx.ev.state.y;
  if (ys === null) throw new Error('keys are not known');
  return dpt(ys[j]);
}

function own(ctx: BuildCtx): { A: Point; C: Point } {
  const A = finalA(ctx.ev.state);
  const C = ctx.ev.state.C;
  if (A === null || C === null) throw new Error('cards are not dealt');
  return { A: dpt(A[ctx.seat]), C: dpt(C[ctx.seat]) };
}

function requirePriv(ctx: BuildCtx): PrivateView {
  if (ctx.priv === null) throw new Error('own card unknown');
  return ctx.priv;
}

function labelIndex(ctx: BuildCtx, priv: PrivateView): number {
  const info = configInfo(ctx.config, ctx.configId);
  const i = info.labels.findIndex((l) => l.role === priv.label.role && l.assassin === priv.label.assassin);
  if (i < 0) throw new Error('own label not in the deck');
  return i;
}

// ---------------------------------------------------------------- setup

export function buildKey(ctx: BuildCtx): Envelope<'key'> {
  const step = pendingStep(ctx, 'key');
  const x = secretKey(ctx.config, secretsOf(ctx));
  const yj = mul(G, x);
  const pok = proveSigma(pokStatement(proofCtx(ctx, step.id), yj), 0, [x], seed(ctx));
  const seedCommit = seedCommitOf(ctx.configId, ctx.seat, beaconSeed(ctx.config, secretsOf(ctx)));
  return envelope(ctx, 'key', step.id, ctx.configId, { y: ept(yj), pok, seedCommit });
}

export function buildShuffle(ctx: BuildCtx): Envelope<'shuffle'> {
  const step = pendingStep(ctx, 'shuffle');
  const s = ctx.ev.state;
  const j = ctx.seat;
  if (s.Y === null) throw new Error('joint key unknown');
  if (s.decks.length !== j) throw new Error(`shuffle ${j}: expected ${j} previous decks, have ${s.decks.length}`);
  const input = j === 0 ? initialDeck(s.deck) : s.decks[j - 1].map(dct);
  const out = proveShuffle(proofCtx(ctx, step.id), dpt(s.Y), input, seed(ctx));
  return envelope(ctx, 'shuffle', step.id, ctx.ev.head, {
    deck: out.deck.map(ect), c: out.c.map(ept), chat: out.chat.map(ept), proof: out.proof,
  });
}

/** §5.11 item 1: x_j·A_i for every i ≠ j, once, after every key and shuffle proof verified. */
export function buildDeal(ctx: BuildCtx): Envelope<'deal'> {
  const step = pendingStep(ctx, 'deal');
  if (!(ctx.ev.pending?.gateOpen ?? false)) throw new Error('deal gate closed: shuffle proofs not verified');
  const A = finalA(ctx.ev.state);
  if (A === null) throw new Error('final deck unknown');
  const Ap = A.map(dpt);
  const x = secretKey(ctx.config, secretsOf(ctx));
  const dPts = Ap.map((Ai, i) => (i === ctx.seat ? null : mul(Ai, x)));
  const proof = proveSigma(dealStatement(proofCtx(ctx, step.id), y(ctx, ctx.seat), Ap, dPts, ctx.seat), 0, [x], seed(ctx));
  return envelope(ctx, 'deal', step.id, ctx.ev.head, { d: dPts.map((P) => (P === null ? null : ept(P))), proof });
}

export function buildOtRecv(ctx: BuildCtx): Envelope<'ot.recv'> {
  const step = pendingStep(ctx, 'ot.recv');
  const priv = requirePriv(ctx);
  const info = configInfo(ctx.config, ctx.configId);
  const real = labelIndex(ctx, priv);
  const x = secretKey(ctx.config, secretsOf(ctx));
  const beta = otBeta(ctx.config, secretsOf(ctx));
  const U = otChoice(beta, priv.c);
  const { A, C } = own(ctx);
  const st = otRecvStatement(proofCtx(ctx, step.id), y(ctx, ctx.seat), A, C, U, info.labelPts, info.labelRoleIdx);
  const proof = proveSigma(st, real, [x, beta], seed(ctx));
  return envelope(ctx, 'ot.recv', step.id, ctx.ev.head, { U: ept(U), proof });
}

export function buildOtSend(ctx: BuildCtx): Envelope<'ot.send'> {
  const step = pendingStep(ctx, 'ot.send');
  const priv = requirePriv(ctx);
  const info = configInfo(ctx.config, ctx.configId);
  const s = ctx.ev.state;
  // E_{Q,r} is released to every receiver Q: only once `otR` completed, i.e. every U_Q was proven (§5.5).
  if (s.cursor.t !== 'otS' || s.U === null || s.U.length !== s.n) throw new Error('receiver commitments unknown');
  const real = labelIndex(ctx, priv);
  const bits = info.seenRows[real];
  const U = s.U.map((u, Q) => (Q === ctx.seat ? null : dpt(u)));
  const sd = seed(ctx);
  const { F, E, f, k } = otSenderMessages(sd, bits, U, ctx.seat);
  const x = secretKey(ctx.config, secretsOf(ctx));
  const { A, C } = own(ctx);
  const pctx = proofCtx(ctx, step.id);
  const profile = proveSigma(otProfileStatement(pctx, y(ctx, ctx.seat), A, C, F, info.labelPts, info.seenRows), real, [x, ...f], sd);
  const kFlat: Scalar[] = [];
  for (const row of k) if (row !== null) kFlat.push(...row);
  const eq = proveSigma(otEqStatement(pctx, F, E, U, ctx.seat), 0, [...f, ...kFlat], sd);
  return envelope(ctx, 'ot.send', step.id, ctx.ev.head, {
    F: F.map(ect), E: E.map((row) => (row === null ? null : row.map(ect))), profile, eq,
    seed: b64uEncode(beaconSeed(ctx.config, secretsOf(ctx))),
  });
}

// ---------------------------------------------------------------- play

/** `team`: seat indices (any order, no duplicates); validated against the rules with the legacy server's messages. */
export function buildPropose(ctx: BuildCtx, team: number[]): Envelope<'propose'> {
  const p = requireRunning(ctx);
  if (p.step.type !== 'propose') throw new Error('Not in team proposal phase');
  if (p.step.req === 'assassin' || p.step.req[0] !== ctx.seat) throw new Error('You are not the proposer');
  const cur = ctx.ev.state.cursor;
  if (cur.t !== 'p') throw new Error('Not in team proposal phase');
  const size = ctx.ev.state.missions[cur.m].teamSize;
  const sorted = [...new Set(team)].sort((a, b) => a - b);
  if (sorted.length !== team.length || sorted.some((x) => !Number.isInteger(x) || x < 0 || x >= ctx.ev.state.n)) {
    throw new Error('Bad team: ' + team.join(','));
  }
  if (sorted.length !== size) throw new Error('Bad team size. Need ' + size);
  return envelope(ctx, 'propose', p.step.id, ctx.ev.head, { team: sorted });
}

function voteNonce(ctx: BuildCtx, vcStepId: string, vcPrev: Hex32): Uint8Array {
  return deriveStream(seed(ctx), 'pvote', vcStepId, hexDecode(vcPrev, 32)).bytes(32);
}

export function buildVoteCommit(ctx: BuildCtx, approve: boolean): Envelope<'vote.commit'> {
  const step = pendingStep(ctx, 'vote.commit');
  const nonce = voteNonce(ctx, step.id, ctx.ev.head);
  const commit = voteCommitOf(ctx.ev.head, ctx.seat, approve, nonce);
  return envelope(ctx, 'vote.commit', step.id, ctx.ev.head, { commit });
}

/** Opens this seat's own commit (the vote is recovered from the deterministic nonce). */
export function buildVoteReveal(ctx: BuildCtx, commitEnv: Envelope<'vote.commit'>): Envelope<'vote.reveal'> {
  const step = pendingStep(ctx, 'vote.reveal');
  if (commitEnv.step !== step.id.replace(/^vr\//, 'vc/') || commitEnv.author !== ctx.me) throw new Error('commit does not belong to this vote');
  const nonce = voteNonce(ctx, commitEnv.step, commitEnv.prev);
  let approve: boolean | null = null;
  for (const a of [true, false]) if (voteCommitOf(commitEnv.prev, ctx.seat, a, nonce) === commitEnv.body.commit) approve = a;
  if (approve === null) throw new Error('own commit does not open');
  return envelope(ctx, 'vote.reveal', step.id, ctx.ev.head, { approve, nonce: b64uEncode(nonce) });
}

/**
 * The mission ballot (§5.9). A good player's FAIL is silently cast as success
 * (v = 0), like the legacy server's flip; the proof is computed with the same
 * work for every branch.
 */
export function buildBallot(ctx: BuildCtx, success: boolean): Envelope<'ballot'> {
  const step = pendingStep(ctx, 'ballot');
  const priv = requirePriv(ctx);
  const info = configInfo(ctx.config, ctx.configId);
  const s = ctx.ev.state;
  if (s.Y === null) throw new Error('joint key unknown');
  const evil = teamOf(priv.label.role) === 'evil';
  const v: 0 | 1 = !success && evil ? 1 : 0;
  const prev = ctx.ev.head;
  const r = ballotRandomness(seed(ctx), step.id, hexDecode(prev, 32), v);
  const Y = dpt(s.Y);
  const ballot = encryptBit(Y, v, r);
  const real = v === 0 ? 0 : 1 + info.evilLabelIdx.indexOf(labelIndex(ctx, priv));
  const x = secretKey(ctx.config, secretsOf(ctx));
  const { A, C } = own(ctx);
  const st = ballotStatement(proofCtx(ctx, step.id), Y, ballot, y(ctx, ctx.seat), A, C, info.evilLabelPts);
  const proof = proveSigma(st, real, v === 0 ? [r] : [r, x], seed(ctx));
  return envelope(ctx, 'ballot', step.id, prev, { ballot: ect(ballot), proof });
}

/** §5.11 item 2: x_j·T_m, once per mission, over the agreed, verified ballots. */
export function buildTally(ctx: BuildCtx): Envelope<'tally'> {
  const step = pendingStep(ctx, 'tally');
  if (!(ctx.ev.pending?.gateOpen ?? false)) throw new Error('tally gate closed');
  const cur = ctx.ev.state.cursor;
  if (cur.t !== 'mt') throw new Error('Not at a tally step');
  const Tm = ctx.ev.state.missions[cur.m].T;
  if (Tm === null) throw new Error('tally base unknown');
  const T = dpt(Tm);
  const x = secretKey(ctx.config, secretsOf(ctx));
  const D = mul(T, x);
  const proof = proveSigma(tallyStatement(proofCtx(ctx, step.id), y(ctx, ctx.seat), T, D), 0, [x], seed(ctx));
  return envelope(ctx, 'tally', step.id, ctx.ev.head, { share: ept(D), proof });
}

/** §5.11 item 3: the opening x_a·A_a, only by the holder of the assassin card. */
export function buildAssassinate(ctx: BuildCtx, target: number): Envelope<'assassinate'> {
  const p = requireRunning(ctx);
  if (p.step.type !== 'assassinate') throw new Error('Not in assassination phase');
  const priv = requirePriv(ctx);
  if (!priv.label.assassin) throw new Error('You are not the assassin');
  if (!Number.isInteger(target) || target < 0 || target >= ctx.ev.state.n || target === ctx.seat) throw new Error('Invalid assassination target');
  const x = secretKey(ctx.config, secretsOf(ctx));
  const { A, C } = own(ctx);
  const Oa = mul(A, x);
  if (!C.subtract(Oa).equals(cardPoint(priv.label))) throw new Error('own card does not open to the assassin card');
  const proof = proveSigma(openStatement(proofCtx(ctx, 'as'), y(ctx, ctx.seat), A, Oa), 0, [x], seed(ctx));
  return envelope(ctx, 'assassinate', 'as', ctx.ev.head, { target, open: ept(Oa), proof });
}

/** A cancel of the pending step (§3.7): `at` = its id, `prev` = D_{k-1}. Needs no secrets. */
export function buildCancel(ctx: BuildCtx, reason: CancelReason): Envelope<'cancel'> {
  const p = ctx.ev.pending;
  if (p === null) throw new Error('No step is pending');
  return envelope(ctx, 'cancel', 'cancel', ctx.ev.head, { at: p.step.id, reason });
}

/**
 * §5.11 item 4: x_j itself plus the randomness of every own ballot on the
 * natural chain, only once the outcome is terminal. `basis` = the terminal's
 * basis (§3.7 rule 3); `prev` = the terminal digest (informational).
 */
export function buildReveal(ctx: BuildCtx): Envelope<'reveal'> {
  const term = ctx.ev.terminal;
  if (term === null) throw new Error('The game is not over');
  if (ctx.ev.pendingReveals.length > 0) throw new Error('Suspended: a reveal is pending');
  const s = ctx.ev.state;
  const sd = seed(ctx);
  const ballots: { m: number; r: string }[] = [];
  s.missions.forEach((ms, m) => {
    if (ms.team === null || ms.ballots === null || ms.ballotPrev === null) return;
    const i = ms.team.indexOf(ctx.seat);
    if (i < 0) return;
    const a = dpt(ms.ballots[i].a);
    const prev = hexDecode(ms.ballotPrev, 32);
    for (const v of [0, 1] as const) {
      const r = ballotRandomness(sd, `mv/${m}`, prev, v);
      if (mul(G, r).equals(a)) {
        ballots.push({ m, r: encScalar(r) });
        return;
      }
    }
  });
  const x = secretKey(ctx.config, secretsOf(ctx));
  return envelope(ctx, 'reveal', 'reveal', ctx.ev.head, { x: encScalar(x), ballots, basis: [...term.basis] });
}

/** §6: one signed log bundle per seat; `createdAt` = the config envelope's t (defaults to ctx.now). */
export function buildLog(ctx: BuildCtx, outcome: GameOutcome, lobbyCode: string, createdAt?: number): Envelope<'log'> {
  if (ctx.ev.terminal === null) throw new Error('The game is not over');
  const game = projectGame(ctx.config, ctx.ev, outcome);
  const body: LogBundle = {
    gameId: ctx.config.gameId, configId: ctx.configId, lobbyCode, outcome,
    missions: game.missions,
    players: ctx.config.seats.map((s) => ({ name: s.name, uid: s.pub })),
    options: { inGameLog: ctx.config.options.inGameLog },
    createdAt: toT(createdAt ?? ctx.now),
  };
  return envelope(ctx, 'log', '', ctx.ev.head, body);
}
