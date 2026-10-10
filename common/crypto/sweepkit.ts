/**
 * Completeness sweep over every deck the game can produce: n = 5..10 and every
 * subset of the selectable roles (384 selections, 332 distinct decks). Covers
 * role combinations the fixed sample decks miss: ASSASSIN without MERLIN,
 * several EVIL MINION labels with and without the assassin flag, decks without
 * Percival or Morgana, and R from 2 to 7. Run by sweep.test.ts and
 * sweep2.test.ts (two shards, so the test runner runs them in parallel).
 *
 * The default run takes every distinct card-label list Λ (116 of them) at the
 * smallest n that produces it, on a table without shuffle and deal proofs
 * (quickTable). For every Λ it checks that every seat decrypts its card and
 * that every receiver decodes its sight bit from one sender, and proves (and
 * batch-verifies) one seat's ot-recv, the sender's ot-profile, a good seat's
 * success ballot, one evil seat's fail ballot and the assassin's opening, with
 * the proven seats rotating through the labels across the sweep. ot-eq is
 * proven once per R, the tally and the refusal of a good seat's fail ballot on
 * every branch on every 8th Λ.
 *
 * AVALON_SLOW_TESTS=1 additionally runs all 332 distinct decks with one proven
 * shuffle, proven dealing, every seat as OT sender and every seat's ballots
 * (about 20-30 minutes).
 */
import assert from 'node:assert/strict';
import { CryptoError, G, O, mul, smallLog, type Point, type Scalar } from './group.ts';
import { ballotRandomness, deriveStream } from './derive.ts';
import { BatchVerifier, proveSigma } from './sigma.ts';
import { encryptBit, type Ct } from './elgamal.ts';
import { cardPoint, labelEq } from './cards.ts';
import {
  ballotStatement, dealStatement, openStatement, otEqStatement, otProfileStatement, otRecvStatement, tallyStatement,
} from './statements.ts';
import { otChoice, otDecode, otSenderMessages } from './ot.ts';
import { allDecks, ctxFor, distinctLabels, otRecv, quickTable, seen, seenRows, setupTable, teamOf, type Table } from './testkit.ts';
import type { CardLabel } from './types.ts';

export const SLOW = process.env.AVALON_SLOW_TESTS === '1';
const PREV = new Uint8Array(32).fill(7);

interface SweepOpts {
  /** Seats whose ot-recv is proven (the others only compute U). */
  recvProofSeats: number[];
  /** OT senders (ot-profile proven; every receiver decodes). */
  senders: number[];
  /** Whether the senders also prove ot-eq (depends only on n and R, not on the roles). */
  eqProof: boolean;
  /** Seats casting proven ballots (success; fail too for evil seats). */
  ballotSeats: number[];
  /** Good seats whose fail ballot must be refused on every branch. */
  refuseSeats: number[];
  /** Evil ballot seats also cast a success ballot (branch 0 is label-independent). */
  evilSuccess: boolean;
  /** Prove every seat's tally share (role-independent). */
  tally: boolean;
}

function sweepDeck(t: Table, opts: SweepOpts): void {
  const { n } = t;
  const bv = new BatchVerifier();
  const add = (what: string, ok: boolean): void => assert.ok(ok, what);
  const A = t.final.map((c) => c.a);
  const key = (l: CardLabel): string => `${l.role}/${l.assassin}`;
  assert.deepEqual(t.seatLabel.map(key).sort(), t.labels.map(key).sort());
  for (let j = 0; j < t.dealProofs.length; j++) {
    add(`deal ${j}`, bv.add(dealStatement(ctxFor('deal', j), t.keys.y[j], A, t.d[j], j), t.dealProofs[j]));
  }

  // sight exchange
  const labelPts = t.Lambda.map(cardPoint);
  const roleIdx = t.Lambda.map((l) => t.roleNames.indexOf(l.role));
  const recv = Array.from({ length: n }, (_, Q) => {
    const beta = deriveStream(t.keys.seeds[Q], 'ot-beta').scalar();
    const c = t.roleNames.indexOf(t.seatLabel[Q].role);
    return { beta, c, U: otChoice(beta, c) };
  });
  for (const Q of opts.recvProofSeats) {
    const r = otRecv(t, Q);
    assert.ok(r.U.equals(recv[Q].U));
    add(`otR ${Q}`, bv.add(otRecvStatement(ctxFor('otR', Q), t.keys.y[Q], A[Q], t.C[Q], r.U, labelPts, roleIdx), r.proof));
  }
  const U: (Point | null)[] = recv.map((r) => r.U);
  const rows = seenRows(t);
  for (const P of opts.senders) {
    const lab = t.seatLabel[P];
    const bits = t.roleNames.map((nu): 0 | 1 => (seen(nu, lab.role) ? 1 : 0));
    const Uo = U.map((u, i) => (i === P ? null : u));
    const s = otSenderMessages(t.keys.seeds[P], bits, Uo, P);
    const profSt = otProfileStatement(ctxFor('otS', P), t.keys.y[P], A[P], t.C[P], s.F, labelPts, rows);
    const real = t.Lambda.findIndex((l) => labelEq(l, lab));
    add(`otS profile ${P}`, bv.add(profSt, proveSigma(profSt, real, [t.keys.x[P], ...s.f], t.keys.seeds[P])));
    if (opts.eqProof) {
      const eqSt = otEqStatement(ctxFor('otS', P), s.F, s.E, Uo, P);
      add(`otS eq ${P}`, bv.add(eqSt, proveSigma(eqSt, 0, [...s.f, ...s.k.flatMap((row) => row ?? [])], t.keys.seeds[P])));
    }
    for (let Q = 0; Q < n; Q++) {
      const row = s.E[Q];
      if (Q === P) continue;
      assert.ok(row !== null);
      assert.equal(otDecode(recv[Q].beta, row[recv[Q].c]), seen(t.seatLabel[Q].role, t.seatLabel[P].role) ? 1 : 0,
        `${t.seatLabel[Q].role} sees ${t.seatLabel[P].role}`);
    }
  }

  // ballots
  const Y = t.keys.Y;
  const evilLabels = t.Lambda.filter((l) => teamOf(l.role) === 'evil');
  const evilPts = evilLabels.map(cardPoint);
  const ballots: Ct[] = [];
  const values: (0 | 1)[] = [];
  for (const Q of opts.ballotSeats) {
    const isEvil = teamOf(t.seatLabel[Q].role) === 'evil';
    const vs: readonly (0 | 1)[] = isEvil ? (opts.evilSuccess ? [0, 1] : [1]) : [0];
    for (const v of vs) {
      const r = ballotRandomness(t.keys.seeds[Q], 'mv/0', PREV, v);
      const ct = encryptBit(Y, v, r);
      const st = ballotStatement(ctxFor('mv/0', Q), Y, ct, t.keys.y[Q], A[Q], t.C[Q], evilPts);
      const real = v === 0 ? 0 : 1 + evilLabels.findIndex((l) => labelEq(l, t.seatLabel[Q]));
      const witness: Scalar[] = v === 0 ? [r] : [r, t.keys.x[Q]];
      add(`ballot ${Q} v=${v}`, bv.add(st, proveSigma(st, real, witness, t.keys.seeds[Q])));
      if (ballots.length < 3 && (v === 1 || !isEvil)) {
        ballots.push(ct);
        values.push(v);
      }
    }
    if (opts.refuseSeats.includes(Q)) {
      assert.ok(!isEvil);
      // a good seat's fail ballot cannot be proven on any branch
      const r = ballotRandomness(t.keys.seeds[Q], 'mv/0', PREV, 1);
      const ct = encryptBit(Y, 1, r);
      const st = ballotStatement(ctxFor('mv/0', Q), Y, ct, t.keys.y[Q], A[Q], t.C[Q], evilPts);
      for (let br = 0; br <= evilLabels.length; br++) {
        assert.throws(() => proveSigma(st, br, br === 0 ? [r] : [r, t.keys.x[Q]], t.keys.seeds[Q]), CryptoError);
      }
    }
  }

  // tally over the collected ballots
  const T = ballots.reduce((acc, b) => acc.add(b.a), O);
  const D = t.keys.x.map((xj) => mul(T, xj));
  for (let j = 0; j < (opts.tally ? n : 0); j++) {
    const st = tallyStatement(ctxFor('mt/0', j), t.keys.y[j], T, D[j]);
    add(`tally ${j}`, bv.add(st, proveSigma(st, 0, [t.keys.x[j]], t.keys.seeds[j])));
  }
  const W = ballots.reduce((acc, b) => acc.add(b.b), O).subtract(D.reduce((acc, d) => acc.add(d), O));
  assert.equal(smallLog(W, ballots.length), values.filter((v) => v === 1).length);

  // assassin's opening
  const a = t.seatLabel.findIndex((l) => l.assassin);
  assert.equal(a >= 0, t.labels.some((l) => l.assassin));
  if (a >= 0) {
    const Oa = mul(A[a], t.keys.x[a]);
    const st = openStatement(ctxFor('as', a), t.keys.y[a], A[a], Oa);
    add('open', bv.add(st, proveSigma(st, 0, [t.keys.x[a]], t.keys.seeds[a])));
    assert.ok(t.C[a].subtract(Oa).equals(cardPoint(t.seatLabel[a])));
    assert.ok(!t.C[a].subtract(Oa).equals(G));
  }
  assert.ok(bv.verify());
}

/** One seat per distinct label, in Λ order. */
function seatPerLabel(t: Table): number[] {
  return t.Lambda.map((l) => t.seatLabel.findIndex((x) => labelEq(x, l)));
}

const all = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/** Every distinct Λ with the first (smallest-n) deck that produces it, in sweep order. */
export function lambdaDecks(): { n: number; selected: string[]; labels: CardLabel[] }[] {
  const byLambda = new Map<string, { n: number; selected: string[]; labels: CardLabel[] }>();
  for (const d of allDecks()) {
    const key = JSON.stringify(distinctLabels(d.labels));
    if (!byLambda.has(key)) byLambda.set(key, d); // decks are in increasing n
  }
  return [...byLambda.values()];
}

/** The default sweep, entries k with k % shards === shard. */
export function runLambdaShard(shard: number, shards: number): number {
  let done = 0;
  const eqDone = new Set<number>();
  lambdaDecks().forEach(({ n, selected, labels }, k) => {
    if (k % shards !== shard) return;
    const t = quickTable(n, labels, k);
    const perLabel = seatPerLabel(t);
    const R = t.roleNames.length; // ot-eq depends only on n and R: prove it once per R
    const goodSeat = t.seatLabel.findIndex((l) => teamOf(l.role) === 'good');
    const evilPerLabel = perLabel.filter((i) => teamOf(t.seatLabel[i].role) === 'evil');
    try {
      sweepDeck(t, {
        recvProofSeats: [perLabel[k % perLabel.length]], senders: [perLabel[(k + 1) % perLabel.length]], eqProof: !eqDone.has(R),
        ballotSeats: [goodSeat, evilPerLabel[k % evilPerLabel.length]], refuseSeats: k % 8 === 0 ? [goodSeat] : [],
        evilSuccess: false, tally: k % 8 === 0,
      });
    } catch (e) {
      throw new Error(`n = ${n}, selected = [${selected.join(', ')}]: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    eqDone.add(R);
    done++;
  });
  return done;
}

/** The slow sweep: all 332 decks with proven shuffle and dealing, every sender and ballot. */
export function runFullSweep(): void {
  for (const { n, selected, labels } of allDecks()) {
    const t = setupTable(n, labels, 1);
    try {
      const good = all(n).filter((i) => teamOf(t.seatLabel[i].role) === 'good');
      sweepDeck(t, { recvProofSeats: all(n), senders: all(n), eqProof: true, ballotSeats: all(n), refuseSeats: good,
        evilSuccess: true, tally: true });
    } catch (e) {
      throw new Error(`n = ${n}, selected = [${selected.join(', ')}]: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
  }
}
