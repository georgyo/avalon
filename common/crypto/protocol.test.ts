/**
 * The cryptographic parts of §5.2-5.5 and §5.9-5.10 end to end: keys, dealing,
 * the sight exchange (OT), ballots, tally and the assassin's opening, with
 * negative tests for every proof type.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES } from '../avalonlib.ts';
import { CodecError } from './bytes.ts';
import { G, GEN, O, decPoint, encPoint, mul, mulPub, smallLog, type Point, type Scalar } from './group.ts';
import { deriveStream } from './derive.ts';
import { BatchVerifier, proveSigma, verifySigma, type ProofContext, type Statement } from './sigma.ts';
import { decCt, encCt, reenc, type Ct } from './elgamal.ts';
import { allPossibleLabels, assertCardPointsDistinct, cardPoint, findLabel, labelEq } from './cards.ts';
import {
  ballotStatement, dealStatement, openStatement, otEqStatement, otProfileStatement, otRecvStatement, pokStatement, tallyStatement,
} from './statements.ts';
import { otChoice, otDecode, otPk, otSenderMessages } from './ot.ts';
import { ctxFor, distinctLabels, forge, otRecv, otSend, roleNamesInPlay, seedFor, seen, seenRows, setupTable, teamOf, type Table } from './testkit.ts';
import type { CardLabel, SigmaProofE } from './types.ts';

function ok(st: Statement, proof: SigmaProofE): boolean {
  const single = verifySigma(st, proof);
  const bv = new BatchVerifier();
  const batch = bv.add(st, proof) && bv.verify();
  assert.equal(single, batch, 'single and batch verification must agree');
  return single;
}

const t5: Table = setupTable(5);
const t10: Table = setupTable(10, undefined, 2); // two shuffles are enough for the OT tests

// ---------------------------------------------------------------- cards and ElGamal

test('card points: 13 possible labels, pairwise distinct, not O or G; cached; findLabel', () => {
  const labels = allPossibleLabels();
  assert.equal(labels.length, ROLES.length + ROLES.filter((r) => r.team === 'evil').length);
  assert.equal(labels.length, 13);
  assertCardPointsDistinct();
  const encs = new Set(labels.map((l) => encPoint(cardPoint(l))));
  assert.equal(encs.size, 13);
  assert.ok(!encs.has(encPoint(G)));
  assert.equal(cardPoint({ role: 'MERLIN', assassin: false }), cardPoint({ role: 'MERLIN', assassin: false }));
  assert.equal(encPoint(cardPoint({ role: 'MERLIN', assassin: false })), 'WPuTAG652OCDNbDMS25McsIGYRnOkVnt6ilOkwXdZkk');
  assert.equal(encPoint(cardPoint({ role: 'ASSASSIN', assassin: true })), '-txBj_oufimK4pC4VpXA5EAnyAiOGM7tI7TlKQxLPgA');
  for (const l of labels) assert.ok(labelEq(findLabel(cardPoint(l), labels) as CardLabel, l));
  assert.equal(findLabel(G, labels), null);
  assert.ok(!labelEq({ role: 'ASSASSIN', assassin: true }, { role: 'ASSASSIN', assassin: false }));
});

test('ElGamal: re-encryption, codec, identity rules', () => {
  const x = 99n;
  const Y = mul(G, x);
  const M = cardPoint({ role: 'PERCIVAL', assassin: false });
  const c0: Ct = { a: O, b: M };
  const c1 = reenc(Y, c0, 5n);
  const c2 = reenc(Y, c1, 7n);
  assert.ok(c2.b.subtract(mul(c2.a, x)).equals(M));
  const e = encCt(c2);
  const d = decCt(e);
  assert.ok(d.a.equals(c2.a) && d.b.equals(c2.b));
  assert.throws(() => decCt(encCt(c0)), CodecError);
  assert.ok(decCt(encCt(c0), { allowIdentityA: true }).a.is0());
  assert.throws(() => decCt({ a: e.a, b: encPoint(O) }, { allowIdentityA: true }), CodecError);
});

// ---------------------------------------------------------------- key (§5.2) and deal (§5.4)

test('key: proofs of knowledge verify; replay to another config, step or prover fails', () => {
  const { keys } = t5;
  for (let j = 0; j < 5; j++) assert.ok(ok(pokStatement(ctxFor('key', j), keys.y[j]), keys.pok[j]));
  const other: ProofContext = { ...ctxFor('key', 0), configId: 'ab'.repeat(32) };
  assert.ok(!ok(pokStatement(other, keys.y[0]), keys.pok[0]), 'replay from another game');
  assert.ok(!ok(pokStatement(ctxFor('key', 1), keys.y[0]), keys.pok[0]), 'copied by another seat');
  assert.ok(!ok(pokStatement(ctxFor('key', 0), keys.y[1]), keys.pok[0]), 'wrong key');
  // rogue key y' = y_attacker − y_victim: the attacker cannot prove knowledge of its log
  const rogue = keys.y[1].subtract(keys.y[0]);
  assert.ok(!ok(pokStatement(ctxFor('key', 1), rogue), forge(pokStatement(ctxFor('key', 1), rogue), 0, [keys.x[1]], seedFor(1))));
});

test('deal: every share proof verifies; each seat decrypts its own card; wrong shares fail', () => {
  const t = t5;
  const A = t.final.map((c) => c.a);
  for (let j = 0; j < t.n; j++) assert.ok(ok(dealStatement(ctxFor('deal', j), t.keys.y[j], A, t.d[j]), t.dealProofs[j]));
  // decrypted labels form the deck multiset
  const key = (l: CardLabel): string => `${l.role}/${l.assassin}`;
  assert.deepEqual(t.seatLabel.map(key).sort(), t.labels.map(key).sort());
  // a wrong share (any position) fails
  for (let i = 1; i < t.n; i++) {
    const bad = t.d[0].map((x, k) => (k === i && x !== null ? x.add(G) : x));
    assert.ok(!ok(dealStatement(ctxFor('deal', 0), t.keys.y[0], A, bad), t.dealProofs[0]), `share ${i}`);
    const badProof = forge(dealStatement(ctxFor('deal', 0), t.keys.y[0], A, bad), 0, [t.keys.x[0]], t.keys.seeds[0]);
    assert.ok(!ok(dealStatement(ctxFor('deal', 0), t.keys.y[0], A, bad), badProof), `reproved share ${i}`);
  }
  // shares for another deck fail
  const A2 = t.inputs[0].map((c, i) => (c.a.is0() ? mul(G, BigInt(i + 3)) : c.a));
  assert.ok(!ok(dealStatement(ctxFor('deal', 0), t.keys.y[0], A2, t.d[0]), t.dealProofs[0]));
});

// ---------------------------------------------------------------- sight exchange (§5.5)

test('OT decode for every (sender label, receiver index)', () => {
  // all possible labels and the full role-name list, without proofs
  const labels = allPossibleLabels();
  const names = ROLES.map((r) => r.name);
  const seed = seedFor(3);
  const n = names.length + 1;
  const betas: Scalar[] = names.map((_, c) => deriveStream(seedFor(c), 'ot-beta').scalar());
  const U: (Point | null)[] = [null, ...names.map((_, c) => otChoice(betas[c], c))]; // receiver Q = c + 1 chooses index c
  for (const l of labels) {
    const bits = names.map((nu): 0 | 1 => (seen(nu, l.role) ? 1 : 0));
    const m = otSenderMessages(seed, bits, U, 0);
    assert.equal(m.E.length, n);
    for (let c = 0; c < names.length; c++) {
      const row = m.E[c + 1];
      assert.ok(row !== null);
      assert.equal(otDecode(betas[c], row[c]), seen(names[c], l.role) ? 1 : 0, `${names[c]} sees ${l.role}/${l.assassin}`);
      // other indices are not decodable with β (they would need log_G S)
      for (let r = 0; r < names.length; r++) if (r !== c) assert.equal(otDecode(betas[c], row[r]), null);
    }
  }
});

test('OT on a 10-seat table: all proofs verify and every seat learns exactly its sees-set', () => {
  const t = t10;
  assert.equal(t.roleNames.length, 7);
  const labelPts = t.Lambda.map(cardPoint);
  const roleIdx = t.Lambda.map((l) => t.roleNames.indexOf(l.role));
  const recv = Array.from({ length: t.n }, (_, Q) => otRecv(t, Q));
  for (let Q = 0; Q < t.n; Q++) {
    const st = otRecvStatement(ctxFor('otR', Q), t.keys.y[Q], t.final[Q].a, t.C[Q], recv[Q].U, labelPts, roleIdx);
    assert.ok(ok(st, recv[Q].proof), `otR ${Q}`);
    assert.equal(recv[Q].proof.K.length, t.Lambda.length);
  }
  const U = recv.map((r) => r.U);
  const sends = [0, 3, 4, 9].map((P) => [P, otSend(t, P, U)] as const);
  const bv = new BatchVerifier();
  for (const [P, s] of sends) {
    const Uo = U.map((u, i) => (i === P ? null : u));
    assert.ok(bv.add(otProfileStatement(ctxFor('otS', P), t.keys.y[P], t.final[P].a, t.C[P], s.F, labelPts, seenRows(t)), s.profile));
    assert.ok(bv.add(otEqStatement(ctxFor('otS', P), s.F, s.E, Uo), s.eq));
    for (let Q = 0; Q < t.n; Q++) {
      const row = s.E[Q];
      if (Q === P) { assert.equal(row, null); continue; }
      assert.ok(row !== null);
      const bit = otDecode(recv[Q].beta, row[recv[Q].c]);
      assert.equal(bit, seen(t.seatLabel[Q].role, t.seatLabel[P].role) ? 1 : 0);
    }
  }
  assert.ok(bv.verify());
});

test('OT negative: a receiver cannot choose another role index (Loyal Follower picking Merlin)', () => {
  const t = t10;
  const labelPts = t.Lambda.map(cardPoint);
  const roleIdx = t.Lambda.map((l) => t.roleNames.indexOf(l.role));
  const Q = t.seatLabel.findIndex((l) => l.role === 'LOYAL FOLLOWER');
  assert.ok(Q >= 0);
  const merlinIdx = t.roleNames.indexOf('MERLIN');
  const beta = 4242n;
  const U = otChoice(beta, merlinIdx);
  const st = otRecvStatement(ctxFor('otR', Q), t.keys.y[Q], t.final[Q].a, t.C[Q], U, labelPts, roleIdx);
  // every branch the cheater could claim fails: the own card does not match Merlin's index,
  // and Merlin's branch needs the card to decrypt to Merlin
  for (let real = 0; real < t.Lambda.length; real++) {
    const proof = forge(st, real, [t.keys.x[Q], beta], t.keys.seeds[Q]);
    assert.ok(!ok(st, proof), `branch ${real}`);
  }
  // the honest proof does not transfer to a different U
  const honest = otRecv(t, Q);
  const st2 = otRecvStatement(ctxFor('otR', Q), t.keys.y[Q], t.final[Q].a, t.C[Q], U, labelPts, roleIdx);
  assert.ok(!ok(st2, honest.proof));
  // otPk: only PK_{Q,c} has a known discrete log
  assert.ok(otPk(honest.U, honest.c).equals(mul(G, honest.beta)));
  assert.ok(!otPk(honest.U, (honest.c + 1) % 7).equals(mul(G, honest.beta)));
});

test('OT negative: lying, tagging one receiver, corrupting one index', () => {
  const t = t10;
  const labelPts = t.Lambda.map(cardPoint);
  const recv = Array.from({ length: t.n }, (_, Q) => otRecv(t, Q));
  const U = recv.map((r) => r.U);
  const P = t.seatLabel.findIndex((l) => l.role === 'MORDRED' || l.role === 'MORGANA');
  assert.ok(P >= 0);
  const Uo = U.map((u, i) => (i === P ? null : u));
  const lab = t.seatLabel[P];
  const realBranch = t.Lambda.findIndex((l) => labelEq(l, lab));
  const trueBits = t.roleNames.map((nu): 0 | 1 => (seen(nu, lab.role) ? 1 : 0));
  const merlin = t.roleNames.indexOf('MERLIN');
  const seed = t.keys.seeds[P];
  const ctx = ctxFor('otS', P);

  // (a) lying profile: flip Merlin's bit (an evil player hiding from Merlin) and prove consistently
  const lieBits = trueBits.map((b, r) => (r === merlin ? ((1 - b) as 0 | 1) : b));
  const lie = otSenderMessages(seed, lieBits, Uo, P);
  const profSt = otProfileStatement(ctx, t.keys.y[P], t.final[P].a, t.C[P], lie.F, labelPts, seenRows(t));
  for (let real = 0; real < t.Lambda.length; real++) {
    assert.ok(!ok(profSt, forge(profSt, real, [t.keys.x[P], ...lie.f], seed)), `profile branch ${real}`);
  }
  const kFlat = (k: (Scalar[] | null)[]): Scalar[] => k.flatMap((row) => row ?? []);
  // its eq proof alone is consistent (same lie everywhere) but the profile cannot be proven
  assert.ok(ok(otEqStatement(ctx, lie.F, lie.E, Uo), proveSigma(otEqStatement(ctx, lie.F, lie.E, Uo), 0, [...lie.f, ...kFlat(lie.k)], seed)));

  // (b) tagging: honest F, but receiver Q gets a different bit at Merlin's index
  const honest = otSenderMessages(seed, trueBits, Uo, P);
  const Q = P === 0 ? 1 : 0;
  const k = honest.k[Q] as Scalar[];
  const tagged = honest.E.map((row, i) => (i !== Q || row === null ? row : row.map((ct, r) => {
    if (r !== merlin) return ct;
    const PK = otPk(U[Q] as Point, r);
    return { a: mul(G, k[r]), b: (trueBits[r] === 1 ? O : G).add(mul(PK, k[r])) };
  })));
  const eqTag = otEqStatement(ctx, honest.F, tagged, Uo);
  assert.ok(!ok(eqTag, forge(eqTag, 0, [...honest.f, ...kFlat(honest.k)], seed)));

  // (c) corrupting one index for one receiver with a random ciphertext
  const corrupt = honest.E.map((row, i) => (i !== Q || row === null ? row : row.map((ct, r) => (r === 2 ? { a: ct.a, b: ct.b.add(GEN.J) } : ct))));
  const eqCor = otEqStatement(ctx, honest.F, corrupt, Uo);
  assert.ok(!ok(eqCor, forge(eqCor, 0, [...honest.f, ...kFlat(honest.k)], seed)));

  // (d) the honest messages verify, and transplanting F into another seat's profile fails
  const honestProf = otProfileStatement(ctx, t.keys.y[P], t.final[P].a, t.C[P], honest.F, labelPts, seenRows(t));
  const prof = proveSigma(honestProf, realBranch, [t.keys.x[P], ...honest.f], seed);
  assert.ok(ok(honestProf, prof));
  const P2 = (P + 1) % t.n;
  assert.ok(!ok(otProfileStatement(ctxFor('otS', P2), t.keys.y[P2], t.final[P2].a, t.C[P2], honest.F, labelPts, seenRows(t)), prof));
  // tampered F
  const F2 = honest.F.map((f, r) => (r === 0 ? { a: f.a, b: f.b.add(G) } : f));
  assert.ok(!ok(otProfileStatement(ctx, t.keys.y[P], t.final[P].a, t.C[P], F2, labelPts, seenRows(t)), prof));
});

// ---------------------------------------------------------------- ballots and tally (§5.9)

interface Ballot { ct: Ct; r: Scalar; v: 0 | 1; proof: SigmaProofE; st: Statement }

function castBallot(t: Table, Y: Point, Q: number, v: 0 | 1, opts: { forceBranch?: number; m?: number } = {}): Ballot {
  const stepId = `mv/${opts.m ?? 0}`;
  const r = deriveStream(t.keys.seeds[Q], 'ballot', stepId, new Uint8Array(32), new Uint8Array([v])).scalar();
  const ct: Ct = { a: mul(G, r), b: (v === 1 ? G : O).add(mul(Y, r)) };
  const evil = t.Lambda.filter((l) => teamOf(l.role) === 'evil');
  const st = ballotStatement(ctxFor(stepId, Q), Y, ct, t.keys.y[Q], t.final[Q].a, t.C[Q], evil.map(cardPoint));
  const own = evil.findIndex((l) => labelEq(l, t.seatLabel[Q]));
  const real = opts.forceBranch ?? (v === 0 ? 0 : 1 + own);
  const witness = real === 0 ? [r] : [r, t.keys.x[Q]];
  return { ct, r, v, st, proof: (opts.forceBranch === undefined ? proveSigma : forge)(st, real, witness, t.keys.seeds[Q]) };
}

test('ballot: every branch is complete; good players cannot fail; copies and re-randomizations fail', () => {
  const t = t5;
  const Y = t.keys.Y;
  const evilSeats = t.seatLabel.map((l, i) => (teamOf(l.role) === 'evil' ? i : -1)).filter((i) => i >= 0);
  const goodSeats = t.seatLabel.map((l, i) => (teamOf(l.role) === 'good' ? i : -1)).filter((i) => i >= 0);
  const nEvilLabels = t.Lambda.filter((l) => teamOf(l.role) === 'evil').length;
  for (const Q of [...evilSeats, ...goodSeats]) {
    const b0 = castBallot(t, Y, Q, 0);
    assert.ok(ok(b0.st, b0.proof), `success ballot seat ${Q}`);
    assert.equal(b0.proof.K.length, 1 + nEvilLabels);
  }
  for (const Q of evilSeats) {
    const b1 = castBallot(t, Y, Q, 1);
    assert.ok(ok(b1.st, b1.proof), `fail ballot evil seat ${Q}`);
  }
  for (const Q of goodSeats) {
    // a good player's fail: no branch can be proven
    for (let br = 0; br <= nEvilLabels; br++) {
      const bad = castBallot(t, Y, Q, 1, { forceBranch: br });
      assert.ok(!ok(bad.st, bad.proof), `good seat ${Q} failing via branch ${br}`);
    }
  }
  // vote value 2
  {
    const Q = evilSeats[0];
    const r = 777n;
    const ct: Ct = { a: mul(G, r), b: G.add(G).add(mul(Y, r)) };
    const evil = t.Lambda.filter((l) => teamOf(l.role) === 'evil');
    const st = ballotStatement(ctxFor('mv/0', Q), Y, ct, t.keys.y[Q], t.final[Q].a, t.C[Q], evil.map(cardPoint));
    for (let br = 0; br <= evil.length; br++) {
      assert.ok(!ok(st, forge(st, br, br === 0 ? [r] : [r, t.keys.x[Q]], t.keys.seeds[Q])), `v = 2 branch ${br}`);
    }
  }
  // copied ballot: seat B republishes seat A's ballot and proof
  const A = evilSeats[0];
  const B = goodSeats[0];
  const orig = castBallot(t, Y, A, 1);
  const evil = t.Lambda.filter((l) => teamOf(l.role) === 'evil').map(cardPoint);
  const copySt = ballotStatement(ctxFor('mv/0', B), Y, orig.ct, t.keys.y[B], t.final[B].a, t.C[B], evil);
  assert.ok(!ok(copySt, orig.proof), 'copied ballot');
  // re-randomized copy: B cannot prove knowledge of the new randomness... it does know δ, but not r
  const delta = 31337n;
  const rr: Ct = { a: orig.ct.a.add(mul(G, delta)), b: orig.ct.b.add(mul(Y, delta)) };
  const rrSt = ballotStatement(ctxFor('mv/0', B), Y, rr, t.keys.y[B], t.final[B].a, t.C[B], evil);
  for (let br = 0; br <= evil.length; br++) {
    assert.ok(!ok(rrSt, forge(rrSt, br, br === 0 ? [delta] : [delta, t.keys.x[B]], t.keys.seeds[B])), `re-randomized via ${br}`);
  }
  // ballot = another seat's card ciphertext (decryption-oracle attempt)
  const cardCt: Ct = { a: t.final[A].a, b: t.C[A] };
  const ocSt = ballotStatement(ctxFor('mv/0', B), Y, cardCt, t.keys.y[B], t.final[B].a, t.C[B], evil);
  for (let br = 0; br <= evil.length; br++) {
    assert.ok(!ok(ocSt, forge(ocSt, br, br === 0 ? [1n] : [1n, t.keys.x[B]], t.keys.seeds[B])), `card ciphertext via ${br}`);
  }
  // mutate ballot ciphertext after proving
  const b = castBallot(t, Y, A, 0);
  const st2 = ballotStatement(ctxFor('mv/0', A), Y, { a: b.ct.a, b: b.ct.b.add(G) }, t.keys.y[A], t.final[A].a, t.C[A], evil);
  assert.ok(!ok(st2, b.proof));
});

test('tally: shares verify, Σb − ΣD = k·G and smallLog recovers the number of fails', () => {
  const t = t5;
  const Y = t.keys.Y;
  const evilSeats = t.seatLabel.map((l, i) => (teamOf(l.role) === 'evil' ? i : -1)).filter((i) => i >= 0);
  const goodSeats = t.seatLabel.map((l, i) => (teamOf(l.role) === 'good' ? i : -1)).filter((i) => i >= 0);
  const team = [evilSeats[0], evilSeats[1], goodSeats[0]];
  for (const fails of [0, 1, 2]) {
    const ballots = team.map((Q, i) => castBallot(t, Y, Q, (i < fails ? 1 : 0) as 0 | 1, { m: fails }));
    for (const b of ballots) assert.ok(ok(b.st, b.proof));
    const T = ballots.reduce((acc, b) => acc.add(b.ct.a), O);
    const D = t.keys.x.map((xj) => mul(T, xj));
    for (let j = 0; j < t.n; j++) {
      const st = tallyStatement(ctxFor(`mt/${fails}`, j), t.keys.y[j], T, D[j]);
      assert.ok(ok(st, proveSigma(st, 0, [t.keys.x[j]], t.keys.seeds[j])));
    }
    const W = ballots.reduce((acc, b) => acc.add(b.ct.b), O).subtract(D.reduce((acc, d) => acc.add(d), O));
    assert.equal(smallLog(W, team.length), fails);
    // per-ballot opening at the end: b − r·Y ∈ {O, G}
    for (const b of ballots) assert.equal(smallLog(b.ct.b.subtract(mulPub(Y, b.r)), 1), b.v);
  }
  // wrong share, or a share for another T, fails
  const T = mul(G, 5n);
  const st = tallyStatement(ctxFor('mt/0', 0), t.keys.y[0], T, mul(T, t.keys.x[0]).add(G));
  assert.ok(!ok(st, forge(st, 0, [t.keys.x[0]], t.keys.seeds[0])));
  const good = tallyStatement(ctxFor('mt/0', 0), t.keys.y[0], T, mul(T, t.keys.x[0]));
  const proof = proveSigma(good, 0, [t.keys.x[0]], t.keys.seeds[0]);
  assert.ok(ok(good, proof));
  assert.ok(!ok(tallyStatement(ctxFor('mt/0', 0), t.keys.y[0], T.add(G), mul(T, t.keys.x[0])), proof));
  assert.ok(!ok(tallyStatement(ctxFor('mt/1', 0), t.keys.y[0], T, mul(T, t.keys.x[0])), proof));
});

// ---------------------------------------------------------------- assassination (§5.10)

test('open: the assassin opens its card; other openings are detected', () => {
  const t = t5;
  const a = t.seatLabel.findIndex((l) => l.assassin);
  assert.ok(a >= 0);
  const star = t.labels.find((l) => l.assassin) as CardLabel;
  const Oa = mul(t.final[a].a, t.keys.x[a]);
  const st = openStatement(ctxFor('as', a), t.keys.y[a], t.final[a].a, Oa);
  const proof = proveSigma(st, 0, [t.keys.x[a]], t.keys.seeds[a]);
  assert.ok(ok(st, proof));
  assert.ok(t.C[a].subtract(Oa).equals(cardPoint(star)));
  // a non-assassin opening validly reveals a non-assassin card
  const b = (a + 1) % t.n;
  const Ob = mul(t.final[b].a, t.keys.x[b]);
  const stb = openStatement(ctxFor('as', b), t.keys.y[b], t.final[b].a, Ob);
  assert.ok(ok(stb, proveSigma(stb, 0, [t.keys.x[b]], t.keys.seeds[b])));
  assert.ok(!t.C[b].subtract(Ob).equals(cardPoint(star)));
  // a forged opening (claiming the assassin card) cannot be proven
  const forged = t.C[b].subtract(cardPoint(star));
  const stf = openStatement(ctxFor('as', b), t.keys.y[b], t.final[b].a, forged);
  assert.ok(!ok(stf, forge(stf, 0, [t.keys.x[b]], t.keys.seeds[b])));
  assert.ok(!ok(openStatement(ctxFor('as', a), t.keys.y[a], t.final[a].a, Oa.add(G)), proof));
});

test('Λ and N_roles helpers of the fixture agree with the deck', () => {
  const labels = t10.labels;
  assert.deepEqual(distinctLabels(labels).length, 7);
  assert.deepEqual(roleNamesInPlay(labels), ['MERLIN', 'PERCIVAL', 'LOYAL FOLLOWER', 'MORGANA', 'MORDRED', 'OBERON', 'ASSASSIN']);
  assert.throws(() => decPoint(encPoint(O)), CodecError);
});
