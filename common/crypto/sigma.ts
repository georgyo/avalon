/**
 * The sigma-proof engine (§2.6): proofs of knowledge of witnesses satisfying
 * linear relations over ristretto255, composed with the CDS OR, under strong
 * Fiat-Shamir. Every proof of the protocol is an instance of this engine.
 *
 * Public facade over sigmaCore.ts. The core's unchecked prover and its batch
 * verifier with an injectable weight source are deliberately not exported here.
 */
import { randomBytes } from './bytes.ts';
import { CryptoError, type Scalar } from './group.ts';
import type { SeedRef } from './derive.ts';
import type { SigmaProofE } from './types.ts';
import { BatchCore, branchHoldsFolded, encodeProof, proveRaw, type Statement } from './sigmaCore.ts';

export type { Branch, Equation, ProofContext, ProofType, Statement, Term } from './sigmaCore.ts';
export { transcriptBase, verifySigma } from './sigmaCore.ts';

/**
 * Proves `st` with real branch `real` and its witness vector (§2.6.3).
 * Nonces come from stream("nonce", proofType, stepId, SHA256(tb)), so the proof is deterministic.
 *
 * Throws CryptoError unless the witness satisfies the real branch: an invalid
 * proof must never be published, because its public residual
 * e_ρ·(Σ w·base − target) is a witness-dependent point (e.g. a seat's own card
 * point for a ballot proven on the wrong branch), and because a later correct
 * proof of the same statement would reuse its nonces. The check runs on the
 * public proof values only (K, e, s), so its timing reveals nothing new; the
 * simulated branches and the Fiat-Shamir split hold by construction, so this
 * is equivalent to verifySigma on the output. The real branch's equations are
 * folded with random 128-bit weights into one MSM (error probability 2^-128).
 */
export function proveSigma(st: Statement, real: number, witness: Scalar[], seed: SeedRef): SigmaProofE {
  const raw = proveRaw(st, real, witness, seed);
  if (!branchHoldsFolded(st.branches[real], raw.e[real], raw.s[real], raw.K[real])) {
    throw new CryptoError('proveSigma: witness does not satisfy the real branch');
  }
  return encodeProof(raw);
}

/**
 * Batch verification (§2.6.4): each added proof is shape- and Fiat-Shamir-checked
 * immediately; its equations are folded with fresh nonzero 128-bit weights from
 * getRandomValues into one MSM evaluated by verify(). Coefficients of identical
 * point objects are merged, so shared bases (G, J, H_i, ...) cost one MSM entry.
 * The weight source cannot be replaced (§2.5: a prover must not predict it).
 */
export class BatchVerifier extends BatchCore {
  constructor() {
    super(randomBytes);
  }
}
