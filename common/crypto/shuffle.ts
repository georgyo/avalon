/**
 * Verifiable shuffle of ElGamal decks: the Terelius-Wikström argument (§5.3)
 * expressed as one `shuffle` sigma statement.
 */
import { concat, hexDecode, lp, sha256, u32, utf8 } from './bytes.ts';
import { CryptoError, G, GEN, H2S, MAX_DECK, O, mod, msm, mul, ptBytesShared, type Point, type Scalar } from './group.ts';
import { deriveStream, type SeedRef } from './derive.ts';
import { proveSigma, type Equation, type ProofContext, type Statement } from './sigma.ts';
import { reenc, type Ct } from './elgamal.ts';
import { cardPoint } from './cards.ts';
import type { CardLabel, SigmaProofE } from './types.ts';

export interface ShuffleOutput { deck: Ct[]; c: Point[]; chat: Point[]; proof: SigmaProofE }

const U_TAG = 'avalon-p2p/v1/shuffle-u';
const PROTOCOL = utf8('avalon-p2p/v1');

/** The canonical initial deck (O, M(λ_i)), computed, never decoded. */
export function initialDeck(labels: readonly CardLabel[]): Ct[] {
  return labels.map((l) => ({ a: O, b: cardPoint(l) }));
}

/** enc(deck) = enc(A_0) ‖ enc(B_0) ‖ enc(A_1) ‖ ... */
export function deckBytes(deck: readonly Ct[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const c of deck) parts.push(ptBytesShared(c.a), ptBytesShared(c.b));
  return concat(...parts);
}

function pointsBytes(ps: readonly Point[]): Uint8Array {
  return concat(...ps.map(ptBytesShared));
}

/** The challenge vector u_{j'} of §5.3 step 3. */
export function shuffleChallenges(ctx: ProofContext, Y: Point, input: readonly Ct[], out: readonly Ct[], c: readonly Point[]): Scalar[] {
  const prefix = concat(
    lp(PROTOCOL), hexDecode(ctx.configId, 32), lp(utf8(ctx.stepId)), lp(utf8(ctx.prover)),
    ptBytesShared(Y), deckBytes(input), deckBytes(out), pointsBytes(c),
  );
  return input.map((_, j) => H2S(U_TAG, concat(prefix, u32(j))));
}

/** The statement's aux: SHA256(enc(in) ‖ enc(out) ‖ enc(c_0..c_{N-1})). */
export function shuffleAux(input: readonly Ct[], out: readonly Ct[], c: readonly Point[]): Uint8Array {
  return sha256(deckBytes(input), deckBytes(out), pointsBytes(c));
}

function checkSizes(N: number, ...lens: number[]): void {
  if (N < 1 || N > MAX_DECK) throw new CryptoError(`shuffle: deck size must be 1..${MAX_DECK}`);
  for (const l of lens) if (l !== N) throw new CryptoError('shuffle: length mismatch');
}

/**
 * The `shuffle` statement (§5.3 step 6), witness order
 * [r̄, r̂, r̃, ρ̄, r̂_0..r̂_{N-1}, u'_0..u'_{N-1}], equations E1..E5 then E6_0..E6_{N-1}.
 */
export function shuffleStatement(ctx: ProofContext, Y: Point, input: Ct[], out: Ct[], c: Point[], chat: Point[]): Statement {
  const N = input.length;
  checkSizes(N, out.length, c.length, chat.length);
  const u = shuffleChallenges(ctx, Y, input, out, c);
  const H = GEN.H.slice(0, N);

  let prodU = 1n;
  for (const x of u) prodU = mod(prodU * x);
  // c̄ = Σ c_j − Σ H_i
  let cBar = O;
  for (const cj of c) cBar = cBar.add(cj);
  for (const h of H) cBar = cBar.subtract(h);
  // ĉ = ĉ_{N-1} − (Π u)·H₀
  const cHat = chat[N - 1].subtract(msm([GEN.H0], [prodU]));
  const cTilde = msm(c, u);
  const aHat = msm(input.map((x) => x.a), u);
  const bHat = msm(input.map((x) => x.b), u);

  const W_RBAR = 0, W_RHAT = 1, W_RTILDE = 2, W_RHOBAR = 3;
  const wRhat = (i: number): number => 4 + i;
  const wU = (i: number): number => 4 + N + i;

  const eqs: Equation[] = [
    { target: cBar, terms: [{ w: W_RBAR, base: G }] },
    { target: cHat, terms: [{ w: W_RHAT, base: G }] },
    { target: cTilde, terms: [{ w: W_RTILDE, base: G }, ...H.map((h, i) => ({ w: wU(i), base: h }))] },
    { target: aHat, terms: [{ w: W_RHOBAR, base: G }, ...out.map((o, i) => ({ w: wU(i), base: o.a }))] },
    { target: bHat, terms: [{ w: W_RHOBAR, base: Y }, ...out.map((o, i) => ({ w: wU(i), base: o.b }))] },
  ];
  for (let i = 0; i < N; i++) {
    eqs.push({ target: chat[i], terms: [{ w: wRhat(i), base: G }, { w: wU(i), base: i === 0 ? GEN.H0 : chat[i - 1] }] });
  }
  return { proofType: 'shuffle', ctx, aux: shuffleAux(input, out, c), branches: [{ nWitness: 4 + 2 * N, eqs }] };
}

/** Shuffles and re-encrypts `input` under the joint key Y and proves it (§5.3, prover). Deterministic in the seed. */
export function proveShuffle(ctx: ProofContext, Y: Point, input: Ct[], seed: SeedRef): ShuffleOutput {
  const N = input.length;
  checkSizes(N);
  const st = deriveStream(seed, 'shuffle', sha256(ptBytesShared(Y), deckBytes(input)));
  // 1. permutation and re-encryption
  const pi = st.perm(N);
  const rho: Scalar[] = [];
  for (let i = 0; i < N; i++) rho.push(st.scalar());
  const out: Ct[] = pi.map((src, i) => reenc(Y, input[src], rho[i]));
  // 2. permutation commitment, indexed by input position: c_{π(i)} = r_{π(i)}·G + H_i
  const r: Scalar[] = [];
  for (let j = 0; j < N; j++) r.push(st.scalar());
  const c: Point[] = new Array<Point>(N);
  for (let i = 0; i < N; i++) c[pi[i]] = mul(G, r[pi[i]]).add(GEN.H[i]);
  // 3. challenges
  const u = shuffleChallenges(ctx, Y, input, out, c);
  const uP = pi.map((src) => u[src]);
  // 4. commitment chain
  const rHat: Scalar[] = [];
  for (let i = 0; i < N; i++) rHat.push(st.scalar());
  const chat: Point[] = [];
  for (let i = 0; i < N; i++) {
    const prev = i === 0 ? GEN.H0 : chat[i - 1];
    chat.push(mul(G, rHat[i]).add(mul(prev, uP[i])));
  }
  // 5. witnesses
  let rBar = 0n;
  let rTilde = 0n;
  for (let j = 0; j < N; j++) {
    rBar += r[j];
    rTilde += r[j] * u[j];
  }
  let rHatAgg = 0n;
  let v = 1n; // v_i = Π_{t=i+1}^{N-1} u'_t, accumulated from the end
  for (let i = N - 1; i >= 0; i--) {
    rHatAgg += rHat[i] * v;
    v = mod(v * uP[i]);
  }
  let rhoBar = 0n;
  for (let i = 0; i < N; i++) rhoBar -= rho[i] * uP[i];
  const witness: Scalar[] = [mod(rBar), mod(rHatAgg), mod(rTilde), mod(rhoBar), ...rHat, ...uP];
  // 6. proof
  const statement = shuffleStatement(ctx, Y, input, out, c, chat);
  const proof = proveSigma(statement, 0, witness, seed);
  return { deck: out, c, chat, proof };
}
