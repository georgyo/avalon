import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b64uEncode, hexDecode, hexEncode, sha256, utf8 } from './bytes.ts';
import { G, GEN, L, decPoint, decScalar, encPoint, encScalar, mod, mul, mulPub, H2C, type Point, type Scalar } from './group.ts';
import { deriveStream } from './derive.ts';
import { BatchVerifier, proveSigma, transcriptBase, verifySigma, type Statement } from './sigma.ts';
import type { SigmaProofE } from './types.ts';
import { CONFIG_ID, ctxFor, seededRandom, seedFor } from './testkit.ts';

const seed = seedFor(0);
const sc = (label: string): Scalar => deriveStream(seed, 'test-witness', label).scalar();
const pt = (label: string): Point => H2C('avalon-p2p/v1/test', utf8(label));

/** One branch, three equations, two witnesses. */
function andStatement(a: Scalar, b: Scalar): Statement {
  return {
    proofType: 'tally', ctx: ctxFor('mt/0', 2), aux: new Uint8Array(0),
    branches: [{
      nWitness: 2,
      eqs: [
        { target: mul(G, a).add(mul(GEN.H0, b)), terms: [{ w: 0, base: G }, { w: 1, base: GEN.H0 }] },
        { target: mul(GEN.S, a), terms: [{ w: 0, base: GEN.S }] },
        { target: mul(GEN.J, b), terms: [{ w: 1, base: GEN.J }] },
      ],
    }],
  };
}

/** Three branches with 1, 2 and 3 witnesses; only branch `real` holds for the returned witness. */
function orStatement(real: number): { st: Statement; witness: Scalar[] } {
  const ws = [[sc('w0')], [sc('w1a'), sc('w1b')], [sc('w2a'), sc('w2b'), sc('w2c')]];
  const branches = ws.map((w, k) => {
    const holds = k === real;
    const eqs = [
      { target: holds ? mul(G, w[0]) : pt(`junk${k}`), terms: [{ w: 0, base: G }] },
      {
        target: holds ? w.reduce((acc: Point, x, j) => acc.add(mul(GEN.H[j], x)), mulPub(G, 0n)) : pt(`junk2${k}`),
        terms: w.map((_, j) => ({ w: j, base: GEN.H[j] })),
      },
    ];
    return { nWitness: w.length, eqs };
  });
  return { st: { proofType: 'ballot', ctx: ctxFor('mv/0', 1), aux: new Uint8Array(0), branches }, witness: ws[real] };
}

function batchOk(st: Statement, proof: SigmaProofE): boolean {
  const bv = new BatchVerifier(seededRandom(11));
  return bv.add(st, proof) && bv.verify();
}

function bump(s: string): string {
  return encScalar(mod(decScalar(s) + 1n));
}

/** Every single-field mutation of a proof. */
function* proofMutations(p: SigmaProofE): Generator<[string, SigmaProofE]> {
  const clone = (): SigmaProofE => ({ K: p.K.map((r) => [...r]), e: [...p.e], s: p.s.map((r) => [...r]) });
  for (let k = 0; k < p.K.length; k++) {
    for (let i = 0; i < p.K[k].length; i++) {
      const q = clone();
      q.K[k][i] = encPoint(decPoint(q.K[k][i], { allowIdentity: true }).add(G));
      yield [`K[${k}][${i}]`, q];
    }
  }
  for (let k = 0; k < p.e.length; k++) {
    const q = clone();
    q.e[k] = bump(q.e[k]);
    yield [`e[${k}]`, q];
  }
  for (let k = 0; k < p.s.length; k++) {
    for (let j = 0; j < p.s[k].length; j++) {
      const q = clone();
      q.s[k][j] = bump(q.s[k][j]);
      yield [`s[${k}][${j}]`, q];
    }
  }
  if (p.e.length > 1) {
    // shift challenge mass between two branches: Σe still matches, equations do not
    const q = clone();
    q.e[0] = bump(q.e[0]);
    q.e[1] = encScalar(mod(decScalar(q.e[1]) - 1n));
    yield ['e[0]+1, e[1]-1', q];
  }
}

/** Every single-point/context mutation of a statement. */
function statementMutations(st: Statement): [string, Statement][] {
  const deep = (): Statement => ({
    ...st, ctx: { ...st.ctx },
    branches: st.branches.map((b) => ({
      nWitness: b.nWitness,
      eqs: b.eqs.map((e) => ({ target: e.target, terms: e.terms.map((t) => ({ ...t })) })),
    })),
  });
  const out: [string, Statement][] = [];
  st.branches.forEach((b, k) => b.eqs.forEach((e, i) => {
    const q = deep();
    q.branches[k].eqs[i].target = e.target.add(G);
    out.push([`target[${k}][${i}]`, q]);
    e.terms.forEach((term, t) => {
      const r = deep();
      r.branches[k].eqs[i].terms[t].base = term.base.add(GEN.S);
      out.push([`base[${k}][${i}][${t}]`, r]);
    });
  }));
  const c1 = deep(); c1.ctx.configId = hexEncode(sha256(utf8('other config'))); out.push(['configId', c1]);
  const c2 = deep(); c2.ctx.stepId = st.ctx.stepId + 'x'; out.push(['stepId', c2]);
  const c3 = deep(); c3.ctx.prover = st.ctx.prover.replace('PUB', 'PUC'); out.push(['prover', c3]);
  const c4 = deep(); c4.proofType = st.proofType === 'pok' ? 'open' : 'pok'; out.push(['proofType', c4]);
  const c5 = deep(); c5.aux = Uint8Array.of(1); out.push(['aux', c5]);
  return out;
}

test('completeness: one branch, several equations', () => {
  const a = sc('a');
  const b = sc('b');
  const st = andStatement(a, b);
  const proof = proveSigma(st, 0, [a, b], seed);
  assert.equal(proof.K.length, 1);
  assert.equal(proof.K[0].length, 3);
  assert.equal(proof.s[0].length, 2);
  assert.ok(verifySigma(st, proof));
  assert.ok(batchOk(st, proof));
  // deterministic (RFC 6979 style)
  assert.deepEqual(proveSigma(st, 0, [a, b], seed), proof);
  // a different seed gives a different but valid proof
  const other = proveSigma(st, 0, [a, b], seedFor(1));
  assert.notDeepEqual(other, proof);
  assert.ok(verifySigma(st, other));
});

test('completeness: CDS OR with every real branch', () => {
  for (let real = 0; real < 3; real++) {
    const { st, witness } = orStatement(real);
    const proof = proveSigma(st, real, witness, seed);
    assert.ok(verifySigma(st, proof), `real = ${real}`);
    assert.ok(batchOk(st, proof));
    assert.equal(mod(proof.e.map(decScalar).reduce((x, y) => x + y, 0n)) < L, true);
  }
});

test('soundness: a false statement cannot be proven', () => {
  const a = sc('a');
  const b = sc('b');
  const st = andStatement(a, b);
  assert.ok(!verifySigma(st, proveSigma(st, 0, [a, mod(b + 1n)], seed)));
  assert.ok(!batchOk(st, proveSigma(st, 0, [mod(a + 1n), b], seed)));
  // OR: claiming a branch that does not hold
  const { st: orSt, witness } = orStatement(1);
  assert.ok(!verifySigma(orSt, proveSigma(orSt, 0, [witness[0]], seed)));
  assert.ok(!verifySigma(orSt, proveSigma(orSt, 2, [witness[0], witness[1], 5n], seed)));
  assert.ok(!batchOk(orSt, proveSigma(orSt, 2, [witness[0], witness[1], 5n], seed)));
});

test('soundness: every proof field mutation is rejected (single and batch)', () => {
  const a = sc('a');
  const b = sc('b');
  const cases: { st: Statement; proof: SigmaProofE }[] = [
    { st: andStatement(a, b), proof: proveSigma(andStatement(a, b), 0, [a, b], seed) },
  ];
  for (let real = 0; real < 3; real++) {
    const { st, witness } = orStatement(real);
    cases.push({ st, proof: proveSigma(st, real, witness, seed) });
  }
  let n = 0;
  for (const { st, proof } of cases) {
    for (const [name, bad] of proofMutations(proof)) {
      assert.ok(!verifySigma(st, bad), name);
      assert.ok(!batchOk(st, bad), name);
      n++;
    }
  }
  assert.ok(n > 30);
});

test('soundness: every statement point and context field mutation is rejected', () => {
  const a = sc('a');
  const b = sc('b');
  const cases: { st: Statement; proof: SigmaProofE }[] = [
    { st: andStatement(a, b), proof: proveSigma(andStatement(a, b), 0, [a, b], seed) },
  ];
  const { st: orSt, witness } = orStatement(2);
  cases.push({ st: orSt, proof: proveSigma(orSt, 2, witness, seed) });
  for (const { st, proof } of cases) {
    let n = 0;
    for (const [name, bad] of statementMutations(st)) {
      assert.ok(!verifySigma(bad, proof), name);
      assert.ok(!batchOk(bad, proof), name);
      n++;
    }
    assert.ok(n >= 8);
  }
});

test('malformed proofs are rejected without throwing', () => {
  const a = sc('a');
  const b = sc('b');
  const st = andStatement(a, b);
  const p = proveSigma(st, 0, [a, b], seed);
  const nonCanonicalScalar = b64uEncode(new Uint8Array(32).fill(0xff));
  const bads: unknown[] = [
    null, 42, {}, { K: p.K, e: p.e }, { ...p, K: [] }, { ...p, e: [...p.e, p.e[0]] },
    { ...p, K: [[...p.K[0], p.K[0][0]]] }, { ...p, K: [p.K[0].slice(1)] },
    { ...p, s: [[...p.s[0], p.s[0][0]]] }, { ...p, s: [p.s[0].slice(1)] },
    { ...p, e: [nonCanonicalScalar] }, { ...p, s: [[p.s[0][0], nonCanonicalScalar]] },
    { ...p, K: [[p.K[0][0] + '=', p.K[0][1], p.K[0][2]]] },
    { ...p, K: [[p.K[0][0], p.K[0][1], 'A'.repeat(42) + 'B']] },
    { ...p, e: [1] }, { ...p, s: [[1, 2]] }, { ...p, K: 'x' },
  ];
  for (const bad of bads) {
    assert.equal(verifySigma(st, bad as SigmaProofE), false, JSON.stringify(bad));
    const bv = new BatchVerifier();
    assert.equal(bv.add(st, bad as SigmaProofE), false);
    assert.equal(bv.size, 0);
  }
});

test('transcriptBase layout (§2.6.2)', () => {
  const st = andStatement(3n, 4n);
  const tb = transcriptBase(st);
  const expectedLen =
    (4 + 13) + (4 + 5) + 32 + (4 + st.ctx.stepId.length) + (4 + st.ctx.prover.length) + 4 + 4 + // header, aux, B
    8 + (32 + 4 + 2 * (4 + 32)) + (32 + 4 + 36) + (32 + 4 + 36);
  assert.equal(tb.length, expectedLen);
  assert.deepEqual(tb.slice(0, 17), Uint8Array.of(0, 0, 0, 13, ...utf8('avalon-p2p/v1')));
  assert.deepEqual(tb.slice(26, 58), hexDecode(CONFIG_ID));
});

test('batch: many proofs, one injected bad equation among 1000 is detected', () => {
  const x = sc('x');
  // B_i = H_{i mod 10} + (i+2)·G, and x·B_i by additions only (keeps the test fast)
  const xG = mulPub(G, x);
  const xH = GEN.H.map((h) => mulPub(h, x));
  const bases: Point[] = [];
  const targets: Point[] = [];
  let kG = G.add(G);
  let kxG = xG.add(xG);
  for (let i = 0; i < 999; i++) {
    bases.push(GEN.H[i % 10].add(kG));
    targets.push(xH[i % 10].add(kxG));
    kG = kG.add(G);
    kxG = kxG.add(xG);
  }
  const mk = (tg: Point[]): Statement => ({
    proofType: 'deal', ctx: ctxFor('deal', 0), aux: new Uint8Array(0),
    branches: [{ nWitness: 1, eqs: [{ target: mul(G, x), terms: [{ w: 0, base: G }] }, ...tg.map((t, i) => ({ target: t, terms: [{ w: 0, base: bases[i] }] }))] }],
  });
  const good = mk(targets);
  assert.equal(good.branches[0].eqs.length, 1000);
  const tampered = [...targets];
  tampered[517] = tampered[517].add(G);
  const bad = mk(tampered);
  const goodProof = proveSigma(good, 0, [x], seed);
  const badProof = proveSigma(bad, 0, [x], seed); // Fiat-Shamir consistent, one equation false

  const bv1 = new BatchVerifier();
  assert.ok(bv1.add(good, goodProof));
  assert.equal(bv1.size, 1000);
  assert.ok(bv1.verify());

  const bv2 = new BatchVerifier();
  assert.ok(bv2.add(bad, badProof)); // passes the shape and Fiat-Shamir checks
  assert.equal(bv2.verify(), false);
  assert.equal(verifySigma(bad, badProof), false);

  // mixed with other valid proofs
  const a = sc('a');
  const b = sc('b');
  const bv3 = new BatchVerifier();
  assert.ok(bv3.add(andStatement(a, b), proveSigma(andStatement(a, b), 0, [a, b], seed)));
  assert.ok(bv3.add(bad, badProof));
  assert.equal(bv3.verify(), false);
});

test('batch: empty batch verifies; deterministic with injected rng', () => {
  assert.ok(new BatchVerifier().verify());
  const a = sc('a');
  const b = sc('b');
  const st = andStatement(a, b);
  const p = proveSigma(st, 0, [a, b], seed);
  const bv = new BatchVerifier(seededRandom(1));
  assert.ok(bv.add(st, p));
  assert.ok(bv.add(st, p));
  assert.ok(bv.verify());
});

test('proveSigma input validation', () => {
  const st = andStatement(1n, 2n);
  assert.throws(() => proveSigma(st, 1, [1n, 2n], seed));
  assert.throws(() => proveSigma(st, 0, [1n], seed));
  assert.throws(() => proveSigma(st, 0, [1n, L], seed));
  const empty: Statement = { ...st, branches: [] };
  assert.throws(() => transcriptBase(empty));
  const badW: Statement = { ...st, branches: [{ nWitness: 1, eqs: [{ target: G, terms: [{ w: 1, base: G }] }] }] };
  assert.throws(() => transcriptBase(badW));
});
