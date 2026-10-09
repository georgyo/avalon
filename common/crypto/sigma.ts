/**
 * The sigma-proof engine (§2.6): proofs of knowledge of witnesses satisfying
 * linear relations over ristretto255, composed with the CDS OR, under strong
 * Fiat-Shamir. Every proof of the protocol is an instance of this engine.
 */
import { concat, hexDecode, lp, randomBytes, sha256, u32, utf8, type RandomSource } from './bytes.ts';
import {
  CryptoError, L, decPoint, decScalar, encPoint, encScalar, H2S, mod, msm, mul, ptBytesShared, randomWeight128,
  type Point, type Scalar,
} from './group.ts';
import { deriveStream, type SeedRef } from './derive.ts';
import type { Hex32, Pub, SigmaProofE } from './types.ts';

export type ProofType = 'pok' | 'shuffle' | 'deal' | 'ot-recv' | 'ot-profile' | 'ot-eq' | 'ballot' | 'tally' | 'open';

/** w = witness index within the branch. */
export interface Term { w: number; base: Point }
/** target = Σ terms[t].w-th witness · terms[t].base */
export interface Equation { target: Point; terms: Term[] }
export interface Branch { nWitness: number; eqs: Equation[] }
export interface ProofContext { configId: Hex32; stepId: string; prover: Pub }
/** aux is empty except for the shuffle (§5.3 step 6). */
export interface Statement { proofType: ProofType; ctx: ProofContext; aux: Uint8Array; branches: Branch[] }

const PROTOCOL = utf8('avalon-p2p/v1');
const FS_TAG_PREFIX = 'avalon-p2p/v1/fs/';

function checkStatement(st: Statement): void {
  if (st.branches.length < 1) throw new CryptoError('statement: no branches');
  for (const br of st.branches) {
    if (!Number.isInteger(br.nWitness) || br.nWitness < 1) throw new CryptoError('statement: invalid witness count');
    if (br.eqs.length < 1) throw new CryptoError('statement: branch without equations');
    for (const eq of br.eqs) {
      if (eq.terms.length < 1) throw new CryptoError('statement: equation without terms');
      for (const t of eq.terms) {
        if (!Number.isInteger(t.w) || t.w < 0 || t.w >= br.nWitness) throw new CryptoError('statement: witness index out of range');
      }
    }
  }
}

/** tb of §2.6.2. */
export function transcriptBase(st: Statement): Uint8Array {
  checkStatement(st);
  const parts: Uint8Array[] = [
    lp(PROTOCOL),
    lp(utf8(st.proofType)),
    hexDecode(st.ctx.configId, 32),
    lp(utf8(st.ctx.stepId)),
    lp(utf8(st.ctx.prover)),
    lp(st.aux),
    u32(st.branches.length),
  ];
  for (const br of st.branches) {
    parts.push(u32(br.nWitness), u32(br.eqs.length));
    for (const eq of br.eqs) {
      parts.push(ptBytesShared(eq.target), u32(eq.terms.length));
      for (const t of eq.terms) parts.push(u32(t.w), ptBytesShared(t.base));
    }
  }
  return concat(...parts);
}

function challenge(st: Statement, tb: Uint8Array, K: Point[][]): Scalar {
  const parts: Uint8Array[] = [tb];
  for (const row of K) for (const k of row) parts.push(ptBytesShared(k));
  return H2S(FS_TAG_PREFIX + st.proofType, concat(...parts));
}

/**
 * Proves `st` with real branch `real` and its witness vector (§2.6.3).
 * Nonces come from stream("nonce", proofType, stepId, SHA256(tb)), so the proof is deterministic.
 */
export function proveSigma(st: Statement, real: number, witness: Scalar[], seed: SeedRef): SigmaProofE {
  const tb = transcriptBase(st);
  const B = st.branches.length;
  if (!Number.isInteger(real) || real < 0 || real >= B) throw new CryptoError('proveSigma: invalid real branch');
  const rb = st.branches[real];
  if (witness.length !== rb.nWitness) throw new CryptoError('proveSigma: witness length mismatch');
  for (const w of witness) {
    if (typeof w !== 'bigint' || w < 0n || w >= L) throw new CryptoError('proveSigma: witness out of range');
  }
  const stream = deriveStream(seed, 'nonce', st.proofType, st.ctx.stepId, sha256(tb));

  const K: Point[][] = st.branches.map(() => []);
  const e: Scalar[] = new Array<Scalar>(B).fill(0n);
  const s: Scalar[][] = st.branches.map(() => []);

  // 1. Simulated branches, in increasing k.
  for (let k = 0; k < B; k++) {
    if (k === real) continue;
    const br = st.branches[k];
    e[k] = stream.scalar();
    for (let j = 0; j < br.nWitness; j++) s[k].push(stream.scalar());
    for (const eq of br.eqs) {
      let acc = mul(eq.target, e[k]).negate();
      for (const t of eq.terms) acc = acc.add(mul(t.base, s[k][t.w]));
      K[k].push(acc);
    }
  }
  // 2. Real branch.
  const omega: Scalar[] = [];
  for (let j = 0; j < rb.nWitness; j++) omega.push(stream.scalar());
  for (const eq of rb.eqs) {
    let acc: Point | null = null;
    for (const t of eq.terms) {
      const p = mul(t.base, omega[t.w]);
      acc = acc === null ? p : acc.add(p);
    }
    // checkStatement guarantees at least one term
    K[real].push(acc as Point);
  }
  if (B > 1) {
    // Same group work as a simulated branch, so the real branch is not visible in the timing.
    const dummy = stream.scalar();
    for (const eq of rb.eqs) mul(eq.target, dummy);
  }
  // 3-4. Challenge and responses.
  const c = challenge(st, tb, K);
  let sumOthers = 0n;
  for (let k = 0; k < B; k++) if (k !== real) sumOthers += e[k];
  e[real] = mod(c - sumOthers);
  for (let j = 0; j < rb.nWitness; j++) s[real].push(mod(omega[j] + e[real] * witness[j]));

  return {
    K: K.map((row) => row.map(encPoint)),
    e: e.map(encScalar),
    s: s.map((row) => row.map(encScalar)),
  };
}

interface ParsedProof { K: Point[][]; e: Scalar[]; s: Scalar[][] }

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Strict shape check and decoding against the statement; null if anything is off. */
function parseProof(st: Statement, proof: unknown): ParsedProof | null {
  if (typeof proof !== 'object' || proof === null) return null;
  const p = proof as Record<string, unknown>;
  const { K, e, s } = p;
  const B = st.branches.length;
  if (!Array.isArray(K) || !Array.isArray(s) || !isStringArray(e)) return null;
  if (K.length !== B || e.length !== B || s.length !== B) return null;
  try {
    const out: ParsedProof = { K: [], e: [], s: [] };
    for (let k = 0; k < B; k++) {
      const br = st.branches[k];
      const Kk: unknown = K[k];
      const sk: unknown = s[k];
      if (!isStringArray(Kk) || Kk.length !== br.eqs.length) return null;
      if (!isStringArray(sk) || sk.length !== br.nWitness) return null;
      out.K.push(Kk.map((x) => decPoint(x, { allowIdentity: true })));
      out.e.push(decScalar(e[k]));
      out.s.push(sk.map(decScalar));
    }
    return out;
  } catch {
    return null;
  }
}

/** Steps 1-2 of §2.6.4: shape, strict decoding and the Fiat-Shamir challenge split. */
function checkFS(st: Statement, proof: unknown): ParsedProof | null {
  const parsed = parseProof(st, proof);
  if (parsed === null) return null;
  const tb = transcriptBase(st);
  const c = challenge(st, tb, parsed.K);
  let sum = 0n;
  for (const ek of parsed.e) sum += ek;
  if (mod(sum) !== c) return null;
  return parsed;
}

/** Calls fn(point, scalar) for every point of Σ s·base − e·target − K. */
function forEachEquationTerm(eq: Equation, e: Scalar, s: Scalar[], K: Point, weight: Scalar,
                             fn: (P: Point, k: Scalar) => void): void {
  for (const t of eq.terms) fn(t.base, weight * s[t.w]);
  fn(eq.target, -weight * e);
  fn(K, -weight);
}

/** Verifies one proof exactly (§2.6.4); never throws. */
export function verifySigma(st: Statement, proof: SigmaProofE): boolean {
  try {
    const parsed = checkFS(st, proof);
    if (parsed === null) return false;
    for (let k = 0; k < st.branches.length; k++) {
      const br = st.branches[k];
      for (let i = 0; i < br.eqs.length; i++) {
        const pts: Point[] = [];
        const scs: Scalar[] = [];
        forEachEquationTerm(br.eqs[i], parsed.e[k], parsed.s[k], parsed.K[k][i], 1n, (P, x) => {
          pts.push(P);
          scs.push(mod(x));
        });
        if (!msm(pts, scs).is0()) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Batch verification (§2.6.4): each added proof is shape- and Fiat-Shamir-checked
 * immediately; its equations are folded with fresh nonzero 128-bit weights into
 * one MSM evaluated by verify(). Coefficients of identical point objects are
 * merged, so shared bases (G, J, H_i, ...) cost one MSM entry.
 */
export class BatchVerifier {
  private readonly coeffs = new Map<Point, Scalar>();
  private readonly rng: RandomSource;
  private nEquations = 0;

  /** rng: source of the batch weights; defaults to getRandomValues (tests inject a deterministic one). */
  constructor(rng: RandomSource = randomBytes) {
    this.rng = rng;
  }

  /** Number of equations folded so far. */
  get size(): number {
    return this.nEquations;
  }

  /** Shape + Fiat-Shamir check; false = invalid now (nothing is added). */
  add(st: Statement, proof: SigmaProofE): boolean {
    let parsed: ParsedProof | null;
    try {
      parsed = checkFS(st, proof);
    } catch {
      return false;
    }
    if (parsed === null) return false;
    const acc = (P: Point, x: Scalar): void => {
      const prev = this.coeffs.get(P);
      this.coeffs.set(P, mod(prev === undefined ? x : prev + x));
    };
    for (let k = 0; k < st.branches.length; k++) {
      const br = st.branches[k];
      for (let i = 0; i < br.eqs.length; i++) {
        const z = randomWeight128(this.rng);
        forEachEquationTerm(br.eqs[i], parsed.e[k], parsed.s[k], parsed.K[k][i], z, acc);
        this.nEquations++;
      }
    }
    return true;
  }

  /** One MSM over all added equations; true iff every added equation holds (with probability 1 − 2^-128). */
  verify(): boolean {
    const pts: Point[] = [];
    const scs: Scalar[] = [];
    for (const [P, x] of this.coeffs) {
      if (x === 0n) continue;
      pts.push(P);
      scs.push(x);
    }
    try {
      return msm(pts, scs).is0();
    } catch {
      return false;
    }
  }
}
