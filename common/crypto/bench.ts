/**
 * WP-A performance acceptance (§13): at n = 10, R = 7 on desktop Node 22,
 *   shuffle prove < 200 ms, shuffle verify < 50 ms,
 *   ot.send prove < 1000 ms, ot.send verify < 250 ms.
 * Run: yarn workspace @avalon/common bench   (exit code 1 if a threshold is missed)
 */
import { decPoint } from './group.ts';
import { decCt, encCt } from './elgamal.ts';
import { encPoint } from './group.ts';
import { BatchVerifier } from './sigma.ts';
import { cardPoint } from './cards.ts';
import { proveShuffle, shuffleStatement } from './shuffle.ts';
import { otEqStatement, otProfileStatement } from './statements.ts';
import { ctxFor, otRecv, otSend, seenRows, setupTable, type Table } from './testkit.ts';
import type { Point } from './group.ts';

interface Result { name: string; medianMs: number; limitMs: number }

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

function time(fn: () => void, runs: number): number {
  fn(); // warm-up (lazy precomputation tables, JIT)
  const ts: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  return median(ts);
}

export function runBench(runs = 5): Result[] {
  const n = 10;
  const t: Table = setupTable(n, undefined, 1);
  const results: Result[] = [];

  // ---- shuffle (seat 1 shuffles the output of shuf/0)
  const input = t.final;
  const ctx = ctxFor('shuf/1', 1);
  results.push({
    name: 'shuffle prove (N=10)', limitMs: 200,
    medianMs: time(() => { proveShuffle(ctx, t.keys.Y, input, t.keys.seeds[1]); }, runs),
  });
  const sh = proveShuffle(ctx, t.keys.Y, input, t.keys.seeds[1]);
  const wire = { deck: sh.deck.map(encCt), c: sh.c.map(encPoint), chat: sh.chat.map(encPoint), proof: sh.proof };
  results.push({
    name: 'shuffle verify (N=10)', limitMs: 50,
    medianMs: time(() => {
      const deck = wire.deck.map((e) => decCt(e));
      const c = wire.c.map((s) => decPoint(s));
      const chat = wire.chat.map((s) => decPoint(s));
      const bv = new BatchVerifier();
      if (!bv.add(shuffleStatement(ctx, t.keys.Y, input, deck, c, chat), wire.proof) || !bv.verify()) throw new Error('shuffle failed');
    }, runs),
  });

  // ---- ot.send (R = 7 role names in the sample 10-player deck)
  if (t.roleNames.length !== 7) throw new Error('bench deck must have R = 7');
  const recv = Array.from({ length: n }, (_, Q) => otRecv(t, Q));
  const U: (Point | null)[] = recv.map((r) => r.U);
  const P = 0;
  results.push({
    name: 'ot.send prove (n=10, R=7)', limitMs: 1000,
    medianMs: time(() => { otSend(t, P, U); }, runs),
  });
  const os = otSend(t, P, U);
  const owire = { F: os.F.map(encCt), E: os.E.map((row) => (row === null ? null : row.map(encCt))), profile: os.profile, eq: os.eq };
  const labelPts = t.Lambda.map(cardPoint);
  const rows = seenRows(t);
  const Uo = U.map((u, i) => (i === P ? null : u));
  results.push({
    name: 'ot.send verify (n=10, R=7)', limitMs: 250,
    medianMs: time(() => {
      const F = owire.F.map((e) => decCt(e));
      const E = owire.E.map((row) => (row === null ? null : row.map((e) => decCt(e))));
      const bv = new BatchVerifier();
      const ok1 = bv.add(otProfileStatement(ctxFor('otS', P), t.keys.y[P], t.final[P].a, t.C[P], F, labelPts, rows), owire.profile);
      const ok2 = bv.add(otEqStatement(ctxFor('otS', P), F, E, Uo), owire.eq);
      if (!ok1 || !ok2 || !bv.verify()) throw new Error('ot.send failed');
    }, runs),
  });
  return results;
}

function main(): void {
  const results = runBench();
  let ok = true;
  for (const r of results) {
    const pass = r.medianMs < r.limitMs;
    ok &&= pass;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(28)} ${r.medianMs.toFixed(1).padStart(8)} ms  (limit ${r.limitMs} ms)`);
  }
  if (!ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
