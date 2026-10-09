import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexEncode, sha256 } from './bytes.ts';
import { G, GEN, O, decPoint, encPoint, mod, mul, type Point, type Scalar } from './group.ts';
import { deriveStream } from './derive.ts';
import { BatchVerifier, proveSigma, transcriptBase, verifySigma } from './sigma.ts';
import { decCt, encCt, reenc, type Ct } from './elgamal.ts';
import { cardPoint, findLabel } from './cards.ts';
import { deckBytes, initialDeck, proveShuffle, shuffleAux, shuffleChallenges, shuffleStatement, type ShuffleOutput } from './shuffle.ts';
import type { ProofContext } from './sigma.ts';
import { ctxFor, makeKeys, sampleDeck, seedFor, type Keys } from './testkit.ts';
import type { CardLabel } from './types.ts';

function verifyShuffle(ctx: ProofContext, Y: Point, input: Ct[], o: { deck: Ct[]; c: Point[]; chat: Point[]; proof: ShuffleOutput['proof'] }): boolean {
  let st;
  try {
    st = shuffleStatement(ctx, Y, input, o.deck, o.c, o.chat);
  } catch {
    return false;
  }
  if (o.deck.some((x) => x.a.is0())) return false;
  const single = verifySigma(st, o.proof);
  const bv = new BatchVerifier();
  const batch = bv.add(st, o.proof) && bv.verify();
  assert.equal(single, batch, 'single and batch verification must agree');
  return single;
}

/** Joint decryption of a deck with all secret keys. */
function decryptAll(keys: Keys, deck: Ct[], labels: CardLabel[]): CardLabel[] {
  const xSum = mod(keys.x.reduce((a, b) => a + b, 0n));
  return deck.map((c) => {
    const l = findLabel(c.b.subtract(mul(c.a, xSum)), labels);
    assert.ok(l !== null);
    return l;
  });
}

const sortKey = (ls: CardLabel[]): string[] => ls.map((l) => `${l.role}/${l.assassin}`).sort();

test('completeness for N = 5..10: two chained shuffles verify and preserve the card multiset', () => {
  for (let n = 5; n <= 10; n++) {
    const keys = makeKeys(n);
    const labels = sampleDeck(n);
    const d0 = initialDeck(labels);
    const s0 = proveShuffle(ctxFor('shuf/0', 0), keys.Y, d0, keys.seeds[0]);
    assert.ok(verifyShuffle(ctxFor('shuf/0', 0), keys.Y, d0, s0), `n = ${n} shuf/0`);
    const s1 = proveShuffle(ctxFor('shuf/1', 1), keys.Y, s0.deck, keys.seeds[1]);
    assert.ok(verifyShuffle(ctxFor('shuf/1', 1), keys.Y, s0.deck, s1), `n = ${n} shuf/1`);
    assert.deepEqual(sortKey(decryptAll(keys, s1.deck, labels)), sortKey(labels));
    for (const c of s1.deck) assert.ok(!c.a.is0());
    // proof shape: one branch, 5 + N equations, 4 + 2N witnesses
    assert.equal(s1.proof.K[0].length, 5 + n);
    assert.equal(s1.proof.s[0].length, 4 + 2 * n);
  }
});

test('wire round trip: encoded output decodes and verifies', () => {
  const keys = makeKeys(6);
  const d0 = initialDeck(sampleDeck(6));
  const s0 = proveShuffle(ctxFor('shuf/0', 0), keys.Y, d0, keys.seeds[0]);
  const wire = JSON.parse(JSON.stringify({ deck: s0.deck.map(encCt), c: s0.c.map(encPoint), chat: s0.chat.map(encPoint), proof: s0.proof })) as {
    deck: { a: string; b: string }[]; c: string[]; chat: string[]; proof: ShuffleOutput['proof'];
  };
  const decoded = { deck: wire.deck.map((e) => decCt(e)), c: wire.c.map((s) => decPoint(s)), chat: wire.chat.map((s) => decPoint(s)), proof: wire.proof };
  assert.ok(verifyShuffle(ctxFor('shuf/0', 0), keys.Y, d0, decoded));
});

test('determinism: same seed and input give identical output; another seed differs', () => {
  const keys = makeKeys(5);
  const d0 = initialDeck(sampleDeck(5));
  const a = proveShuffle(ctxFor('shuf/0', 0), keys.Y, d0, keys.seeds[0]);
  const b = proveShuffle(ctxFor('shuf/0', 0), keys.Y, d0, keys.seeds[0]);
  assert.deepEqual(a.deck.map(encCt), b.deck.map(encCt));
  assert.deepEqual(a.proof, b.proof);
  const c = proveShuffle(ctxFor('shuf/0', 0), keys.Y, d0, seedFor(99));
  assert.notDeepEqual(a.deck.map(encCt), c.deck.map(encCt));
});

test('pinned test vector: shuffle aux and SHA256(tb) at N = 5', () => {
  const keys = makeKeys(5);
  const input = initialDeck(sampleDeck(5));
  const ctx = ctxFor('shuf/0', 0);
  const out = proveShuffle(ctx, keys.Y, input, keys.seeds[0]);
  const st = shuffleStatement(ctx, keys.Y, input, out.deck, out.c, out.chat);
  assert.equal(hexEncode(shuffleAux(input, out.deck, out.c)), 'c5b07180faff88e90d820b9009dd37d39c998ddf24f6941375529864a81a742d');
  assert.equal(hexEncode(sha256(transcriptBase(st))), 'a5aac8224610ec3a53d81d7942bed60a143c30e67365000072f21a98e7f6d8e6');
  assert.deepEqual(st.aux, sha256(deckBytes(input), deckBytes(out.deck), ...out.c.map((p) => decPoint(encPoint(p)).toBytes())));
});

/**
 * A cheating prover: identity permutation commitment, arbitrary output cards.
 * It follows the honest witness computation, so with honest outputs it is a valid shuffle.
 */
function cheatShuffle(ctx: ProofContext, Y: Point, input: Ct[], makeOut: (i: number, rho: Scalar) => Ct, seedNo: number): ShuffleOutput {
  const N = input.length;
  const st = deriveStream(seedFor(seedNo), 'cheat');
  const rho = input.map(() => st.scalar());
  const out = input.map((_, i) => makeOut(i, rho[i]));
  const r = input.map(() => st.scalar());
  const c = r.map((ri, j) => mul(G, ri).add(GEN.H[j]));
  const u = shuffleChallenges(ctx, Y, input, out, c);
  const rHat = input.map(() => st.scalar());
  const chat: Point[] = [];
  for (let i = 0; i < N; i++) chat.push(mul(G, rHat[i]).add(mul(i === 0 ? GEN.H0 : chat[i - 1], u[i])));
  let rBar = 0n, rTilde = 0n, rHatAgg = 0n, rhoBar = 0n, v = 1n;
  for (let j = 0; j < N; j++) { rBar += r[j]; rTilde += r[j] * u[j]; rhoBar -= rho[j] * u[j]; }
  for (let i = N - 1; i >= 0; i--) { rHatAgg += rHat[i] * v; v = mod(v * u[i]); }
  const stmt = shuffleStatement(ctx, Y, input, out, c, chat);
  const proof = proveSigma(stmt, 0, [mod(rBar), mod(rHatAgg), mod(rTilde), mod(rhoBar), ...rHat, ...u], seedFor(seedNo));
  return { deck: out, c, chat, proof };
}

test('cheating provers: duplicated, replaced and dropped cards are rejected', () => {
  const n = 7;
  const keys = makeKeys(n);
  const labels = sampleDeck(n);
  const ctx = ctxFor('shuf/0', 0);
  const s0 = proveShuffle(ctx, keys.Y, initialDeck(labels), keys.seeds[0]);
  const input = s0.deck; // a non-trivial input deck
  const ctx1 = ctxFor('shuf/1', 1);

  // sanity: the cheat harness with honest outputs is a valid shuffle
  const honest = cheatShuffle(ctx1, keys.Y, input, (i, rho) => reenc(keys.Y, input[i], rho), 1);
  assert.ok(verifyShuffle(ctx1, keys.Y, input, honest));

  // duplicate: card 0 twice, card 1 gone
  const dup = cheatShuffle(ctx1, keys.Y, input, (i, rho) => reenc(keys.Y, input[i === 1 ? 0 : i], rho), 2);
  assert.ok(!verifyShuffle(ctx1, keys.Y, input, dup));
  // replace: card 3 becomes a fresh MERLIN encryption
  const merlin = cardPoint({ role: 'MERLIN', assassin: false });
  const rep = cheatShuffle(ctx1, keys.Y, input, (i, rho) => (i === 3 ? { a: mul(G, rho), b: merlin.add(mul(keys.Y, rho)) } : reenc(keys.Y, input[i], rho)), 3);
  assert.ok(!verifyShuffle(ctx1, keys.Y, input, rep));
  // drop: card 2 replaced by an encryption of the identity
  const drop = cheatShuffle(ctx1, keys.Y, input, (i, rho) => (i === 2 ? { a: mul(G, rho), b: mul(keys.Y, rho) } : reenc(keys.Y, input[i], rho)), 4);
  assert.ok(!verifyShuffle(ctx1, keys.Y, input, drop));
  // re-encryption under a different key
  const other = mul(G, 12345n);
  const wrongKey = cheatShuffle(ctx1, keys.Y, input, (i, rho) => reenc(i === 0 ? other : keys.Y, input[i], rho), 5);
  assert.ok(!verifyShuffle(ctx1, keys.Y, input, wrongKey));
});

test('tampering with an honest shuffle output is rejected', () => {
  const n = 6;
  const keys = makeKeys(n);
  const input = initialDeck(sampleDeck(n));
  const ctx = ctxFor('shuf/0', 0);
  const s = proveShuffle(ctx, keys.Y, input, keys.seeds[0]);
  assert.ok(verifyShuffle(ctx, keys.Y, input, s));

  const swapDeck = [...s.deck];
  [swapDeck[0], swapDeck[1]] = [swapDeck[1], swapDeck[0]];
  const dupDeck = [...s.deck];
  dupDeck[1] = s.deck[0];
  const reDeck = [...s.deck];
  reDeck[2] = reenc(keys.Y, s.deck[2], 77n); // re-randomized after proving
  const cases: [string, ShuffleOutput][] = [
    ['duplicated card', { ...s, deck: dupDeck }],
    ['swapped cards', { ...s, deck: swapDeck }],
    ['re-randomized card', { ...s, deck: reDeck }],
    ['replaced card', { ...s, deck: s.deck.map((x, i) => (i === 4 ? { a: x.a, b: x.b.add(G) } : x)) }],
    ['dropped card', { ...s, deck: s.deck.slice(1) }],
    ['wrong permutation commitment', { ...s, c: s.c.map((x, i) => (i === 0 ? x.add(G) : x)) }],
    ['swapped permutation commitments', { ...s, c: [s.c[1], s.c[0], ...s.c.slice(2)] }],
    ['wrong commitment chain', { ...s, chat: s.chat.map((x, i) => (i === 2 ? x.add(G) : x)) }],
    ['dropped commitment', { ...s, c: s.c.slice(1) }],
  ];
  for (const [name, bad] of cases) assert.ok(!verifyShuffle(ctx, keys.Y, input, bad), name);
  // other context, key or input
  assert.ok(!verifyShuffle(ctxFor('shuf/1', 0), keys.Y, input, s), 'other step');
  assert.ok(!verifyShuffle(ctxFor('shuf/0', 1), keys.Y, input, s), 'other prover');
  assert.ok(!verifyShuffle(ctx, keys.Y.add(G), input, s), 'other joint key');
  const otherInput = initialDeck([...sampleDeck(n)].reverse());
  assert.ok(!verifyShuffle(ctx, keys.Y, otherInput, s), 'other input deck');
});

test('identity A in an output deck is rejected at decoding', () => {
  const keys = makeKeys(5);
  const input = initialDeck(sampleDeck(5));
  const s = proveShuffle(ctxFor('shuf/0', 0), keys.Y, input, keys.seeds[0]);
  const e = encCt(s.deck[0]);
  assert.throws(() => decCt({ a: encPoint(O), b: e.b }));
  // the initial deck legitimately has identity A components
  assert.ok(input.every((c) => c.a.is0()));
});
