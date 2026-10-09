/**
 * Statement builders, one per proof type of §2.6.5. Prover and verifier build
 * the same statement from public data; it is never transmitted.
 *
 * Equation and witness orders follow §2.6.5 exactly.
 */
import { CryptoError, G, GEN, mulPub, type Point } from './group.ts';
import type { Branch, Equation, ProofContext, Statement } from './sigma.ts';
import type { Ct } from './elgamal.ts';

const EMPTY = new Uint8Array(0);

/** −J, used as a base in ot-eq (a shared object so batch MSMs merge it). */
export const NEG_J: Point = GEN.J.negate().precompute(8, true);

function eq(target: Point, ...terms: [number, Point][]): Equation {
  return { target, terms: terms.map(([w, base]) => ({ w, base })) };
}

/** pok: y = x·G. Witness [x]. */
export function pokStatement(ctx: ProofContext, y: Point): Statement {
  return { proofType: 'pok', ctx, aux: EMPTY, branches: [{ nWitness: 1, eqs: [eq(y, [0, G])] }] };
}

/**
 * deal: y_j = x·G; d_{j,i} = x·A_i for every i with d[i] !== null, increasing i. Witness [x].
 * The caller checks that d is null exactly at the dealer's own seat.
 */
export function dealStatement(ctx: ProofContext, y: Point, A: Point[], d: (Point | null)[]): Statement {
  if (A.length !== d.length) throw new CryptoError('dealStatement: length mismatch');
  const eqs: Equation[] = [eq(y, [0, G])];
  for (let i = 0; i < A.length; i++) {
    const di = d[i];
    if (di !== null) eqs.push(eq(di, [0, A[i]]));
  }
  return { proofType: 'deal', ctx, aux: EMPTY, branches: [{ nWitness: 1, eqs }] };
}

/**
 * ot-recv: one branch per label λ of Λ (Λ order). Witness [x, β].
 *   y_Q = x·G;  C_Q − M(λ) = x·A_Q;  U_Q − idx(λ.role)·S = β·G
 */
export function otRecvStatement(ctx: ProofContext, y: Point, A: Point, C: Point, U: Point,
                                labelPts: Point[], labelRoleIdx: number[]): Statement {
  if (labelPts.length !== labelRoleIdx.length || labelPts.length < 1) throw new CryptoError('otRecvStatement: label mismatch');
  const uMinus = new Map<number, Point>();
  const branches: Branch[] = labelPts.map((M, l) => {
    const idx = labelRoleIdx[l];
    if (!Number.isInteger(idx) || idx < 0) throw new CryptoError('otRecvStatement: invalid role index');
    let t = uMinus.get(idx);
    if (t === undefined) {
      t = U.subtract(mulPub(GEN.S, BigInt(idx)));
      uMinus.set(idx, t);
    }
    return { nWitness: 2, eqs: [eq(y, [0, G]), eq(C.subtract(M), [0, A]), eq(t, [1, G])] };
  });
  return { proofType: 'ot-recv', ctx, aux: EMPTY, branches };
}

/**
 * ot-profile: one branch per label λ of Λ. Witness [x, f_0..f_{R-1}].
 *   y_P = x·G;  C_P − M(λ) = x·A_P;  for each r: F_r.a = f_r·G, F_r.b − seen(ν_r, λ.role)·G = f_r·J
 * seenRows[λ][r] = seen(ν_r, λ.role).
 */
export function otProfileStatement(ctx: ProofContext, y: Point, A: Point, C: Point, F: Ct[],
                                   labelPts: Point[], seenRows: (0 | 1)[][]): Statement {
  const R = F.length;
  if (R < 1 || labelPts.length < 1 || seenRows.length !== labelPts.length) throw new CryptoError('otProfileStatement: shape mismatch');
  const fbMinusG = F.map((f) => f.b.subtract(G));
  const branches: Branch[] = labelPts.map((M, l) => {
    const row = seenRows[l];
    if (row.length !== R) throw new CryptoError('otProfileStatement: seen row length mismatch');
    const eqs: Equation[] = [eq(y, [0, G]), eq(C.subtract(M), [0, A])];
    for (let r = 0; r < R; r++) {
      const bit = row[r];
      if (bit !== 0 && bit !== 1) throw new CryptoError('otProfileStatement: seen bit must be 0 or 1');
      eqs.push(eq(F[r].a, [1 + r, G]));
      eqs.push(eq(bit === 1 ? fbMinusG[r] : F[r].b, [1 + r, GEN.J]));
    }
    return { nWitness: 1 + R, eqs };
  });
  return { proofType: 'ot-profile', ctx, aux: EMPTY, branches };
}

/**
 * ot-eq: one branch. Witness [f_0..f_{R-1}, k_{Q,r} for Q ≠ P increasing, r increasing].
 *   F_r.a = f_r·G (all r first); then for each Q, r:
 *   E_{Q,r}.a = k_{Q,r}·G;  E_{Q,r}.b − F_r.b = k_{Q,r}·PK_{Q,r} + f_r·(−J),  PK_{Q,r} = U_Q − r·S
 * E[Q] is null exactly for the sender; U[Q] must be present wherever E[Q] is.
 */
export function otEqStatement(ctx: ProofContext, F: Ct[], E: (Ct[] | null)[], U: (Point | null)[]): Statement {
  const R = F.length;
  if (R < 1 || E.length !== U.length) throw new CryptoError('otEqStatement: shape mismatch');
  const eqs: Equation[] = [];
  for (let r = 0; r < R; r++) eqs.push(eq(F[r].a, [r, G]));
  let q = 0;
  for (let Q = 0; Q < E.length; Q++) {
    const EQ = E[Q];
    if (EQ === null) continue;
    const UQ = U[Q];
    if (UQ === null) throw new CryptoError('otEqStatement: missing receiver commitment');
    if (EQ.length !== R) throw new CryptoError('otEqStatement: ciphertext row length mismatch');
    let PK = UQ;
    for (let r = 0; r < R; r++) {
      if (r > 0) PK = PK.subtract(GEN.S);
      const w = R + q * R + r;
      eqs.push(eq(EQ[r].a, [w, G]));
      eqs.push(eq(EQ[r].b.subtract(F[r].b), [w, PK], [r, NEG_J]));
    }
    q++;
  }
  return { proofType: 'ot-eq', ctx, aux: EMPTY, branches: [{ nWitness: R + q * R, eqs }] };
}

/**
 * ballot: branch 0 (v = 0), witness [r]: a = r·G, b = r·Y.
 * Then one branch per evil label λ (Λ order), witness [r, x]:
 *   a = r·G;  b − G = r·Y;  y_Q = x·G;  C_Q − M(λ) = x·A_Q
 */
export function ballotStatement(ctx: ProofContext, Y: Point, ballot: Ct, y: Point, A: Point, C: Point,
                                evilLabelPts: Point[]): Statement {
  const bMinusG = ballot.b.subtract(G);
  const branches: Branch[] = [{ nWitness: 1, eqs: [eq(ballot.a, [0, G]), eq(ballot.b, [0, Y])] }];
  for (const M of evilLabelPts) {
    branches.push({
      nWitness: 2,
      eqs: [eq(ballot.a, [0, G]), eq(bMinusG, [0, Y]), eq(y, [1, G]), eq(C.subtract(M), [1, A])],
    });
  }
  return { proofType: 'ballot', ctx, aux: EMPTY, branches };
}

/** tally: y_j = x·G; D_{j,m} = x·T_m. Witness [x]. */
export function tallyStatement(ctx: ProofContext, y: Point, T: Point, D: Point): Statement {
  return { proofType: 'tally', ctx, aux: EMPTY, branches: [{ nWitness: 1, eqs: [eq(y, [0, G]), eq(D, [0, T])] }] };
}

/** open: y_a = x·G; O_a = x·A_a. Witness [x]. */
export function openStatement(ctx: ProofContext, y: Point, A: Point, Oa: Point): Statement {
  return { proofType: 'open', ctx, aux: EMPTY, branches: [{ nWitness: 1, eqs: [eq(y, [0, G]), eq(Oa, [0, A])] }] };
}
