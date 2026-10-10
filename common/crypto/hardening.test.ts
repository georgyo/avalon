/**
 * Regression tests for the WP-A review findings: prover self-check, null-shape
 * and identity checks in the statement builders, degenerate OT choice
 * commitments, the identity tally base, batch weights that cannot be injected,
 * sparse proof arrays, the ballot randomness stream and the internal exports.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RandomSource } from './bytes.ts';
import { CryptoError, G, GEN, L, O, decPoint, decScalar, encPoint, encScalar, mod, mul, mulPub, ptBytes, type Point, type Scalar } from './group.ts';
import { ballotRandomness, deriveStream } from './derive.ts';
import { BatchVerifier, proveSigma, verifySigma, type Statement } from './sigma.ts';
import { BatchCore, proveSigmaUnchecked } from './sigmaCore.ts';
import { encryptBit, type Ct } from './elgamal.ts';
import { cardPoint, findLabel, labelEq } from './cards.ts';
import { shuffleStatement } from './shuffle.ts';
import {
  ballotStatement, dealStatement, openStatement, otEqStatement, otProfileStatement, otRecvStatement, pokStatement, tallyStatement,
} from './statements.ts';
import { otChoice, otSenderMessages } from './ot.ts';
import { ctxFor, otRecv, otSend, seedFor, seenRows, setupTable, teamOf, type Table } from './testkit.ts';
import type { CardLabel, SigmaProofE } from './types.ts';
import * as api from './index.ts';

const t: Table = setupTable(5, undefined, 1);
const A = t.final.map((c) => c.a);
const labelPts = t.Lambda.map(cardPoint);
const roleIdx = t.Lambda.map((l) => t.roleNames.indexOf(l.role));
const evilLabels = t.Lambda.filter((l) => teamOf(l.role) === 'evil');
const evilPts = evilLabels.map(cardPoint);
const goodSeat = t.seatLabel.findIndex((l) => teamOf(l.role) === 'good');
const evilSeat = t.seatLabel.findIndex((l) => teamOf(l.role) === 'evil');

function inv(a: Scalar): Scalar {
  let r = 1n;
  let b = mod(a);
  let e = L - 2n;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % L;
    b = (b * b) % L;
    e >>= 1n;
  }
  return r;
}

const isCryptoError = (msg: RegExp) => (e: unknown): boolean => e instanceof CryptoError && msg.test(e.message);

// ---------------------------------------------------------------- proveSigma self-check (findings 1, 10)

test('proveSigma refuses a wrong witness: no proof exists whose nonces could leak x', () => {
  const x = t.keys.x[0];
  const st = pokStatement(ctxFor('key', 0), t.keys.y[0]);
  assert.throws(() => proveSigma(st, 0, [1n], t.keys.seeds[0]), isCryptoError(/witness does not satisfy/));
  // Why: the unchecked engine shares nonces between the bad and the good proof, and x falls out.
  const bad = proveSigmaUnchecked(st, 0, [1n], t.keys.seeds[0]);
  const good = proveSigma(st, 0, [x], t.keys.seeds[0]);
  assert.ok(!verifySigma(st, bad));
  assert.ok(verifySigma(st, good));
  assert.deepEqual(bad.K, good.K);
  const e = decScalar(good.e[0]);
  assert.equal(mod((decScalar(good.s[0][0]) - decScalar(bad.s[0][0])) * inv(e) + 1n), x);
});

test('proveSigma refuses a good seat ballot on an evil branch (it would publish the own card point)', () => {
  const Q = goodSeat;
  const r = ballotRandomness(t.keys.seeds[Q], 'mv/0', new Uint8Array(32), 1);
  const ct = encryptBit(t.keys.Y, 1, r);
  const st = ballotStatement(ctxFor('mv/0', Q), t.keys.Y, ct, t.keys.y[Q], A[Q], t.C[Q], evilPts);
  for (let b = 1; b <= evilLabels.length; b++) {
    assert.throws(() => proveSigma(st, b, [r, t.keys.x[Q]], t.keys.seeds[Q]), isCryptoError(/witness does not satisfy/));
    // the unchecked proof's 4th-equation residual is e·(M(λ) − M(own)): any observer recovers M(own)
    const p = proveSigmaUnchecked(st, b, [r, t.keys.x[Q]], t.keys.seeds[Q]);
    assert.ok(!verifySigma(st, p));
    const e = decScalar(p.e[b]);
    const s1 = decScalar(p.s[b][1]);
    const K3 = decPoint(p.K[b][3], { allowIdentity: true });
    const target = t.C[Q].subtract(evilPts[b - 1]);
    const residual = mulPub(A[Q], s1).subtract(mulPub(target, e)).subtract(K3);
    const own = evilPts[b - 1].subtract(mulPub(residual, inv(e)));
    assert.ok(own.equals(cardPoint(t.seatLabel[Q])));
  }
});

test('proveSigma refuses a wrong real branch even with a witness valid for another branch', () => {
  const Q = evilSeat;
  const r = ballotRandomness(t.keys.seeds[Q], 'mv/0', new Uint8Array(32), 1);
  const ct = encryptBit(t.keys.Y, 1, r);
  const st = ballotStatement(ctxFor('mv/0', Q), t.keys.Y, ct, t.keys.y[Q], A[Q], t.C[Q], evilPts);
  const own = 1 + evilLabels.findIndex((l) => labelEq(l, t.seatLabel[Q]));
  assert.ok(verifySigma(st, proveSigma(st, own, [r, t.keys.x[Q]], t.keys.seeds[Q])));
  for (let b = 1; b <= evilLabels.length; b++) {
    if (b !== own) assert.throws(() => proveSigma(st, b, [r, t.keys.x[Q]], t.keys.seeds[Q]), CryptoError);
  }
  assert.throws(() => proveSigma(st, 0, [r], t.keys.seeds[Q]), CryptoError); // v = 1 is not branch 0
});

// ---------------------------------------------------------------- null shapes (findings 2, 11)

test('dealStatement: exactly one null share, at the dealer seat when given', () => {
  const j = 0;
  const d = t.d[j];
  assert.ok(verifySigma(dealStatement(ctxFor('deal', j), t.keys.y[j], A, d, j), t.dealProofs[j]));
  assert.ok(verifySigma(dealStatement(ctxFor('deal', j), t.keys.y[j], A, d), t.dealProofs[j]));
  // share for victim seat 2 withheld: two nulls
  const withheld = d.map((x, i) => (i === 2 ? null : x));
  assert.throws(() => dealStatement(ctxFor('deal', j), t.keys.y[j], A, withheld), isCryptoError(/exactly one null/));
  // no null at all, or the null at another seat than the dealer's
  const full = d.map((x) => x ?? G);
  assert.throws(() => dealStatement(ctxFor('deal', j), t.keys.y[j], A, full), isCryptoError(/exactly one null/));
  const moved = d.map((x, i) => (i === 3 ? null : i === j ? mul(A[j], t.keys.x[j]) : x));
  assert.throws(() => dealStatement(ctxFor('deal', j), t.keys.y[j], A, moved, j), isCryptoError(/at the prover's seat/));
  assert.throws(() => dealStatement(ctxFor('deal', j), t.keys.y[j], A, d, 7), isCryptoError(/invalid prover seat/));
});

test('otEqStatement: exactly one null row, at the sender seat when given; rows need U', () => {
  const recv = Array.from({ length: t.n }, (_, Q) => otRecv(t, Q));
  const U: (Point | null)[] = recv.map((r) => r.U);
  const P = 1;
  const s = otSend(t, P, U);
  const Uo = U.map((u, i) => (i === P ? null : u));
  assert.ok(verifySigma(otEqStatement(ctxFor('otS', P), s.F, s.E, Uo, P), s.eq));
  // receiver Q's row omitted (selective failure against one receiver)
  const omitted = s.E.map((row, i) => (i === 3 ? null : row));
  assert.throws(() => otEqStatement(ctxFor('otS', P), s.F, omitted, Uo), isCryptoError(/exactly one null/));
  assert.throws(() => otEqStatement(ctxFor('otS', P), s.F, s.E, Uo, 0), isCryptoError(/at the prover's seat/));
  assert.throws(() => otEqStatement(ctxFor('otS', P), s.F, s.E, Uo.slice(1)), isCryptoError(/shape mismatch/));
  const noU = Uo.map((u, i) => (i === 3 ? null : u));
  assert.throws(() => otEqStatement(ctxFor('otS', P), s.F, s.E, noU), isCryptoError(/missing receiver commitment/));
});

// ---------------------------------------------------------------- ot-eq malleability (finding 3, documented)

test('ot-eq alone is malleable in F.b and E.b; the ot-profile over the same F rejects the shift', () => {
  const recv = Array.from({ length: t.n }, (_, Q) => otRecv(t, Q));
  const U: (Point | null)[] = recv.map((r) => r.U);
  const P = 2;
  const s = otSend(t, P, U);
  const Uo = U.map((u, i) => (i === P ? null : u));
  const delta = mul(GEN.H0, 5n);
  const shift = (c: Ct): Ct => ({ a: c.a, b: c.b.add(delta) });
  const F2 = s.F.map(shift);
  const E2 = s.E.map((row) => (row === null ? null : row.map(shift)));
  assert.ok(verifySigma(otEqStatement(ctxFor('otS', P), F2, E2, Uo, P), s.eq), 'ot-eq does not bind F.b');
  const prof = otProfileStatement(ctxFor('otS', P), t.keys.y[P], A[P], t.C[P], F2, labelPts, seenRows(t));
  assert.ok(!verifySigma(prof, s.profile), 'ot-profile pins F.b');
});

// ---------------------------------------------------------------- degenerate choice commitments (findings 4, 8)

test('ot-recv with β = 0 (U = idx·S) is rejected by the builder; senders refuse PK = O', () => {
  const Q = goodSeat;
  for (let c = 0; c < t.roleNames.length; c++) {
    const U = mulPub(GEN.S, BigInt(c)); // β = 0
    assert.throws(() => otRecvStatement(ctxFor('otR', Q), t.keys.y[Q], A[Q], t.C[Q], U, labelPts, roleIdx),
      c === 0 ? isCryptoError(/U is the identity/) : isCryptoError(/degenerate choice commitment/));
    // whatever index c was chosen, a sender refuses to build messages for it (defense in depth)
    const P = (Q + 1) % t.n;
    const Ubad: (Point | null)[] = t.keys.y.map((_, i) =>
      (i === P ? null : i === Q ? U : otChoice(deriveStream(seedFor(i), 'ot-beta').scalar(), 0)));
    const bits = t.roleNames.map((): 0 | 1 => 0);
    assert.throws(() => otSenderMessages(t.keys.seeds[P], bits, Ubad, P), isCryptoError(/degenerate receiver key/));
  }
  // the unchecked engine would happily prove it: the builder is the guard
  const honest = otRecv(t, Q);
  assert.ok(verifySigma(otRecvStatement(ctxFor('otR', Q), t.keys.y[Q], A[Q], t.C[Q], honest.U, labelPts, roleIdx), honest.proof));
});

test('otEqStatement rejects a receiver commitment with PK_{Q,r} = O', () => {
  const recv = Array.from({ length: t.n }, (_, Q) => otRecv(t, Q));
  const U: (Point | null)[] = recv.map((r) => r.U);
  const P = 0;
  const s = otSend(t, P, U);
  const Uo = U.map((u, i) => (i === P ? null : u));
  const bad = Uo.map((u, i) => (i === 1 ? mulPub(GEN.S, 2n) : u));
  assert.throws(() => otEqStatement(ctxFor('otS', P), s.F, s.E, bad, P), isCryptoError(/PK\[1\]\[2\] is the identity/));
});

// ---------------------------------------------------------------- tally base T_m = O (finding 9)

test('colluding ballots with r2 = −r1 are valid but give T_m = O, which tallyStatement rejects', () => {
  const evilSeats = t.seatLabel.map((l, i) => (teamOf(l.role) === 'evil' ? i : -1)).filter((i) => i >= 0);
  assert.ok(evilSeats.length >= 2);
  const r1 = 123456789n;
  const rs = [r1, L - r1];
  const ballots = evilSeats.slice(0, 2).map((Q, i) => {
    const ct = encryptBit(t.keys.Y, 1, rs[i]);
    const st = ballotStatement(ctxFor('mv/0', Q), t.keys.Y, ct, t.keys.y[Q], A[Q], t.C[Q], evilPts);
    const own = 1 + evilLabels.findIndex((l) => labelEq(l, t.seatLabel[Q]));
    assert.ok(verifySigma(st, proveSigma(st, own, [rs[i], t.keys.x[Q]], t.keys.seeds[Q])));
    return ct;
  });
  assert.ok(!ballots[0].a.equals(ballots[1].a));
  const T = ballots[0].a.add(ballots[1].a);
  assert.ok(T.is0());
  assert.throws(() => tallyStatement(ctxFor('mt/0', 0), t.keys.y[0], T, O), isCryptoError(/T is the identity/));
});

// ---------------------------------------------------------------- identity points in builders (finding 12)

test('every statement builder rejects identity points where §2.3 requires non-identity', () => {
  const ctx = ctxFor('x', 0);
  const y = t.keys.y[0];
  const C = t.C[0];
  const ct: Ct = encryptBit(t.keys.Y, 0, 5n);
  const F: Ct[] = [{ a: mul(G, 3n), b: G }];
  const cases: [string, () => Statement][] = [
    ['pok y', () => pokStatement(ctx, O)],
    ['deal y', () => dealStatement(ctx, O, A, t.d[0])],
    ['deal A', () => dealStatement(ctx, y, A.map((a, i) => (i === 1 ? O : a)), t.d[0])],
    ['deal d', () => dealStatement(ctx, y, A, t.d[0].map((d, i) => (i === 1 ? O : d)))],
    ['otRecv y', () => otRecvStatement(ctx, O, A[0], C, G, labelPts, roleIdx)],
    ['otRecv A', () => otRecvStatement(ctx, y, O, C, G, labelPts, roleIdx)],
    ['otRecv U', () => otRecvStatement(ctx, y, A[0], C, O, labelPts, roleIdx)],
    ['otProfile y', () => otProfileStatement(ctx, O, A[0], C, F, [labelPts[0]], [[0]])],
    ['otProfile A', () => otProfileStatement(ctx, y, O, C, F, [labelPts[0]], [[0]])],
    ['otProfile F.a', () => otProfileStatement(ctx, y, A[0], C, [{ a: O, b: G }], [labelPts[0]], [[0]])],
    ['otEq F.a', () => otEqStatement(ctx, [{ a: O, b: G }], [null, [ct]], [null, G])],
    ['otEq E.a', () => otEqStatement(ctx, F, [null, [{ a: O, b: G }]], [null, G])],
    ['otEq U', () => otEqStatement(ctx, F, [null, [ct]], [null, O])],
    ['ballot Y', () => ballotStatement(ctx, O, ct, y, A[0], C, evilPts)],
    ['ballot a', () => ballotStatement(ctx, t.keys.Y, { a: O, b: G }, y, A[0], C, evilPts)],
    ['ballot y', () => ballotStatement(ctx, t.keys.Y, ct, O, A[0], C, evilPts)],
    ['ballot A', () => ballotStatement(ctx, t.keys.Y, ct, y, O, C, evilPts)],
    ['tally y', () => tallyStatement(ctx, O, G, G)],
    ['tally T', () => tallyStatement(ctx, y, O, G)],
    ['tally D', () => tallyStatement(ctx, y, G, O)],
    ['open y', () => openStatement(ctx, O, A[0], G)],
    ['open A', () => openStatement(ctx, y, O, G)],
    ['open O_a', () => openStatement(ctx, y, A[0], O)],
    ['shuffle Y', () => shuffleStatement(ctx, O, t.inputs[0], t.final, t.shuffles[0].c, t.shuffles[0].chat)],
    ['shuffle out A', () => shuffleStatement(ctx, t.keys.Y, t.inputs[0], t.final.map((c, i) => (i === 2 ? { a: O, b: c.b } : c)),
      t.shuffles[0].c, t.shuffles[0].chat)],
  ];
  for (const [name, build] of cases) assert.throws(build, isCryptoError(/identity/), name);
  // sanity: the honest shuffle statement still builds
  assert.ok(verifySigma(shuffleStatement(ctxFor('shuf/0', 0), t.keys.Y, t.inputs[0], t.final, t.shuffles[0].c, t.shuffles[0].chat),
    t.shuffles[0].proof));
});

// ---------------------------------------------------------------- batch weights, sparse arrays (finding 6)

/** Two false pok proofs whose residuals cancel when both equations get the same weight. */
function cancellingPair(): { st: Statement[]; proofs: SigmaProofE[] } {
  const x = t.keys.x[0];
  const deltas = [11n, 13n];
  const st = deltas.map((d, i) => pokStatement(ctxFor(`forge/${i}`, 0), mul(G, mod(x + d))));
  const proofs = st.map((s) => proveSigmaUnchecked(s, 0, [x], t.keys.seeds[0]));
  // residual_i = e_i·(x·G − y_i) = −e_i·δ_i·G; shift s_1 by e_0·δ_0 + e_1·δ_1 so that residual_0 + residual_1 = O
  const e0 = decScalar(proofs[0].e[0]);
  const e1 = decScalar(proofs[1].e[0]);
  proofs[1] = { ...proofs[1], s: [[encScalar(mod(decScalar(proofs[1].s[0][0]) + e0 * deltas[0] + e1 * deltas[1]))]] };
  return { st, proofs };
}

test('batch weights: a constant source accepts a cancelling forgery; BatchVerifier cannot be given one', () => {
  const { st, proofs } = cancellingPair();
  for (let i = 0; i < 2; i++) assert.ok(!verifySigma(st[i], proofs[i]));
  const constant: RandomSource = (n) => new Uint8Array(n).fill(1);
  const weak = new BatchCore(constant);
  assert.ok(weak.add(st[0], proofs[0]) && weak.add(st[1], proofs[1]));
  assert.equal(weak.verify(), true, 'predictable weights let the forgery through');
  const bv = new BatchVerifier();
  assert.ok(bv.add(st[0], proofs[0]) && bv.add(st[1], proofs[1]));
  assert.equal(bv.verify(), false);
  // an rng smuggled past the type system is ignored
  const Smuggled = BatchVerifier as unknown as new (rng: RandomSource) => BatchVerifier;
  const bv2 = new Smuggled(constant);
  assert.ok(bv2.add(st[0], proofs[0]) && bv2.add(st[1], proofs[1]));
  assert.equal(bv2.verify(), false);
});

test('sparse proof arrays are rejected without throwing (single and batch)', () => {
  const st = pokStatement(ctxFor('key', 0), t.keys.y[0]);
  const p = t.keys.pok[0];
  const holeS: string[] = new Array<string>(1);
  const holeK: string[] = new Array<string>(1);
  const holeOuter: string[][] = new Array<string[]>(1);
  const bads: SigmaProofE[] = [
    { ...p, s: [holeS] },
    { ...p, K: [holeK] },
    { ...p, s: holeOuter },
    { ...p, K: holeOuter },
    { ...p, e: new Array<string>(1) },
  ];
  for (const bad of bads) {
    assert.equal(verifySigma(st, bad), false);
    const bv = new BatchVerifier();
    assert.equal(bv.add(st, bad), false);
    assert.equal(bv.size, 0);
    assert.ok(bv.verify());
  }
});

// ---------------------------------------------------------------- findLabel (finding 7)

test('findLabel scans every label and returns the first match', () => {
  const labels: CardLabel[] = [
    { role: 'MERLIN', assassin: false }, { role: 'MORGANA', assassin: true }, { role: 'MORGANA', assassin: true },
    { role: 'LOYAL FOLLOWER', assassin: false },
  ];
  for (const l of labels) assert.equal(findLabel(cardPoint(l), labels), labels.find((x) => labelEq(x, l)));
  assert.equal(findLabel(G, labels), null);
});

// ---------------------------------------------------------------- ballot stream (finding 13)

/** Independently recomputed from the §2.5 formula with raw HKDF/HMAC (seat 4 test seed, gameId GAME_ID). */
const PINNED_BALLOT_R = 'xYRIRbIlOlwnnMUHWQbcts1QuAB_v06hMz_HHX8TdAU';

test('ballotRandomness encodes v as u8 (not u32) and is pinned', () => {
  const seed = seedFor(4);
  const prev = new Uint8Array(32).fill(0xab);
  for (const v of [0, 1] as const) {
    const r = ballotRandomness(seed, 'mv/2', prev, v);
    assert.equal(r, deriveStream(seed, 'ballot', 'mv/2', prev, Uint8Array.of(v)).scalar());
    assert.notEqual(r, deriveStream(seed, 'ballot', 'mv/2', prev, v).scalar(), 'a number context item is u32');
  }
  assert.equal(encScalar(ballotRandomness(seed, 'mv/2', prev, 1)), PINNED_BALLOT_R);
  assert.throws(() => ballotRandomness(seed, 'mv/2', prev.slice(1), 0), CryptoError);
});

test('encryptBit builds (r·G, v·G + r·Y)', () => {
  const Y = t.keys.Y;
  for (const v of [0, 1] as const) {
    const c = encryptBit(Y, v, 77n);
    assert.ok(c.a.equals(mul(G, 77n)));
    assert.ok(c.b.subtract(mul(Y, 77n)).equals(v === 1 ? G : O));
  }
  assert.throws(() => encryptBit(Y, 2 as 0 | 1, 77n), CryptoError);
});

// ---------------------------------------------------------------- internal exports (findings 6, 14)

test('index.ts does not export the internal helpers; ptBytes returns a fresh copy', () => {
  const names = new Set(Object.keys(api));
  for (const internal of ['ptBytesShared', 'randomWeight128From', 'proveSigmaUnchecked', 'proveRaw', 'BatchCore', 'branchHolds',
    'branchHoldsFolded', 'encodeProof']) {
    assert.ok(!names.has(internal), internal);
  }
  for (const pub of ['ptBytes', 'encPoint', 'proveSigma', 'verifySigma', 'BatchVerifier', 'randomWeight128', 'transcriptBase',
    'ballotRandomness', 'encryptBit', 'dealStatement', 'GEN', 'CryptoError']) {
    assert.ok(names.has(pub), pub);
  }
  const P = mul(G, 9n);
  const before = encPoint(P);
  const b = ptBytes(P);
  b.fill(0);
  assert.equal(encPoint(P), before);
});
