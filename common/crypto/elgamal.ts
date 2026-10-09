/**
 * ElGamal ciphertexts over ristretto255 (§5): (A, B) = (ρ·G, M + ρ·Z).
 */
import { CodecError } from './bytes.ts';
import { CryptoError, G, O, decPoint, encPoint, mul, type Point, type Scalar } from './group.ts';
import type { CtE } from './types.ts';

export interface Ct { a: Point; b: Point }

/** ReEnc_ρ(A, B) = (A + ρ·G, B + ρ·Y); ρ is secret (0 < ρ < L). */
export function reenc(Y: Point, c: Ct, rho: Scalar): Ct {
  return { a: c.a.add(mul(G, rho)), b: c.b.add(mul(Y, rho)) };
}

/** Indexable [O, G]: v·G for a secret bit v without branching on it. */
const BIT_POINTS: readonly Point[] = [O, G];

/**
 * Bit encryption (r·G, v·G + r·Y) for ballots (§5.9), built
 * without branching on the secret bit v; r is secret (0 < r < L).
 */
export function encryptBit(Y: Point, v: 0 | 1, r: Scalar): Ct {
  if (v !== 0 && v !== 1) throw new CryptoError('encryptBit: v must be 0 or 1');
  return { a: mul(G, r), b: BIT_POINTS[v].add(mul(Y, r)) };
}

export function encCt(c: Ct): CtE {
  return { a: encPoint(c.a), b: encPoint(c.b) };
}

/**
 * Strict ciphertext decoder. Both components reject the identity (§2.3: the
 * identity is allowed only as the A component of the computed initial deck);
 * `allowIdentityA` relaxes that for A only. Throws CodecError.
 */
export function decCt(e: CtE, opts?: { allowIdentityA?: boolean }): Ct {
  if (typeof e !== 'object' || e === null) throw new CodecError('ciphertext: not an object');
  return { a: decPoint(e.a, { allowIdentity: opts?.allowIdentityA === true }), b: decPoint(e.b) };
}
