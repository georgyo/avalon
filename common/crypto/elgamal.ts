/**
 * ElGamal ciphertexts over ristretto255 (§5): (A, B) = (ρ·G, M + ρ·Z).
 */
import { CodecError } from './bytes.ts';
import { G, decPoint, encPoint, mul, type Point, type Scalar } from './group.ts';
import type { CtE } from './types.ts';

export interface Ct { a: Point; b: Point }

/** ReEnc_ρ(A, B) = (A + ρ·G, B + ρ·Y); ρ is secret (0 < ρ < L). */
export function reenc(Y: Point, c: Ct, rho: Scalar): Ct {
  return { a: c.a.add(mul(G, rho)), b: c.b.add(mul(Y, rho)) };
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
