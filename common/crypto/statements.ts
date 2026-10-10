/**
 * Statement builders, one per proof type of §2.6.5. Prover and verifier build
 * the same statement from public data; it is never transmitted.
 *
 * Equation and witness orders follow §2.6.5 exactly.
 *
 * Every builder throws CryptoError on a degenerate statement instead of
 * returning one: identity points where §2.3 requires non-identity values
 * (checked here as well, so computed values such as Y and T_m that are never
 * decoded are covered too), a choice commitment U_Q equal to idx·S, and a
 * `null` share/row anywhere but at exactly one position. Callers treat a
 * throwing builder like a failed proof of the message being checked.
 */
import { CryptoError, G, GEN, mul, mulPub, type Point } from './group.ts';
import type { Branch, Equation, ProofContext, Statement } from './sigma.ts';
import type { Ct } from './elgamal.ts';

const EMPTY = new Uint8Array(0);

/** −J, used as a base in ot-eq (a shared object so batch MSMs merge it). */
export const NEG_J: Point = GEN.J.negate().precompute(8, true);

function eq(target: Point, ...terms: [number, Point][]): Equation {
  return { target, terms: terms.map(([w, base]) => ({ w, base })) };
}

/** §2.3: throws CryptoError if P is the identity. */
function nonId(P: Point, builder: string, what: string): void {
  if (P.is0()) throw new CryptoError(`${builder}: ${what} is the identity`);
}

/**
 * Exactly one entry of `xs` is null; if `self` is given it must be that entry.
 * A row or share omitted for any other seat (a targeted stall, or selective
 * failure against one receiver) is thereby rejected by the builder itself.
 */
function checkSingleNull<T>(xs: readonly (T | null)[], self: number | undefined, builder: string): void {
  let nulls = 0;
  for (const x of xs) if (x === null) nulls++;
  if (nulls !== 1) throw new CryptoError(`${builder}: expected exactly one null entry (the prover's own seat), got ${nulls}`);
  if (self !== undefined) {
    if (!Number.isInteger(self) || self < 0 || self >= xs.length) throw new CryptoError(`${builder}: invalid prover seat`);
    if (xs[self] !== null) throw new CryptoError(`${builder}: the null entry must be at the prover's seat`);
  }
}

/** pok: y = x·G. Witness [x]. */
export function pokStatement(ctx: ProofContext, y: Point): Statement {
  nonId(y, 'pokStatement', 'y');
  return { proofType: 'pok', ctx, aux: EMPTY, branches: [{ nWitness: 1, eqs: [eq(y, [0, G])] }] };
}

/**
 * deal: y_j = x·G; d_{j,i} = x·A_i for every i with d[i] !== null, increasing i. Witness [x].
 * Exactly one entry of d must be null (throws otherwise). `self` (the dealer's
 * seat, an addition to the §11.2 signature) additionally pins it to d[self];
 * callers that do not pass it MUST check that position themselves.
 */
export function dealStatement(ctx: ProofContext, y: Point, A: Point[], d: (Point | null)[], self?: number): Statement {
  if (A.length !== d.length) throw new CryptoError('dealStatement: length mismatch');
  checkSingleNull(d, self, 'dealStatement');
  nonId(y, 'dealStatement', 'y');
  const eqs: Equation[] = [eq(y, [0, G])];
  for (let i = 0; i < A.length; i++) {
    nonId(A[i], 'dealStatement', `A[${i}]`);
    const di = d[i];
    if (di !== null) {
      nonId(di, 'dealStatement', `d[${i}]`);
      eqs.push(eq(di, [0, A[i]]));
    }
  }
  return { proofType: 'deal', ctx, aux: EMPTY, branches: [{ nWitness: 1, eqs }] };
}

/**
 * ot-recv: one branch per label λ of Λ (Λ order). Witness [x, β].
 *   y_Q = x·G;  C_Q − M(λ) = x·A_Q;  U_Q − idx(λ.role)·S = β·G
 * Throws if U_Q = idx·S for a role index of Λ (β = 0): then PK_{Q,idx} = O and
 * every sender's E_{Q,idx} would carry its sight bit in clear (or be the
 * identity, which honest receivers of otS reject). Λ covers every role index
 * in [0, R), so this rejects every degenerate PK_{Q,r}.
 */
export function otRecvStatement(ctx: ProofContext, y: Point, A: Point, C: Point, U: Point,
                                labelPts: Point[], labelRoleIdx: number[]): Statement {
  if (labelPts.length !== labelRoleIdx.length || labelPts.length < 1) throw new CryptoError('otRecvStatement: label mismatch');
  nonId(y, 'otRecvStatement', 'y');
  nonId(A, 'otRecvStatement', 'A');
  nonId(U, 'otRecvStatement', 'U');
  const uMinus = new Map<number, Point>();
  const branches: Branch[] = labelPts.map((M, l) => {
    const idx = labelRoleIdx[l];
    if (!Number.isInteger(idx) || idx < 0) throw new CryptoError('otRecvStatement: invalid role index');
    let t = uMinus.get(idx);
    if (t === undefined) {
      t = U.subtract(mulPub(GEN.S, BigInt(idx)));
      if (t.is0()) throw new CryptoError('otRecvStatement: degenerate choice commitment (U = idx·S)');
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
  nonId(y, 'otProfileStatement', 'y');
  nonId(A, 'otProfileStatement', 'A');
  for (let r = 0; r < R; r++) nonId(F[r].a, 'otProfileStatement', `F[${r}].a`);
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
 * Exactly one entry of E must be null (throws otherwise); `self` (the sender's
 * seat, an addition to the §11.2 signature) additionally pins it to E[self];
 * callers that do not pass it MUST check that position themselves. U[Q] must be
 * present wherever E[Q] is, and no PK_{Q,r} may be the identity.
 *
 * Malleability: the transcript binds F_r.a, E_{Q,r}.a and only the differences
 * E_{Q,r}.b − F_r.b, so shifting every F_r.b and E_{Q,r}.b by one point keeps
 * this proof valid. F_r.b is pinned by the ot-profile proof over the SAME F, so
 * a verifier MUST accept an otS body only if both ot-profile and ot-eq verify
 * on the identical decoded F (never ot-eq alone).
 */
export function otEqStatement(ctx: ProofContext, F: Ct[], E: (Ct[] | null)[], U: (Point | null)[], self?: number): Statement {
  const R = F.length;
  if (R < 1 || E.length !== U.length) throw new CryptoError('otEqStatement: shape mismatch');
  checkSingleNull(E, self, 'otEqStatement');
  const eqs: Equation[] = [];
  for (let r = 0; r < R; r++) {
    nonId(F[r].a, 'otEqStatement', `F[${r}].a`);
    eqs.push(eq(F[r].a, [r, G]));
  }
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
      nonId(PK, 'otEqStatement', `PK[${Q}][${r}]`);
      nonId(EQ[r].a, 'otEqStatement', `E[${Q}][${r}].a`);
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
  nonId(Y, 'ballotStatement', 'Y');
  nonId(ballot.a, 'ballotStatement', 'ballot a');
  nonId(y, 'ballotStatement', 'y');
  nonId(A, 'ballotStatement', 'A');
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

/**
 * tally: y_j = x·G; D_{j,m} = x·T_m. Witness [x].
 * Throws if T_m or D_{j,m} is the identity (§2.3). Note: colluding team members
 * can make T_m = Σ a = O with individually valid ballots (r_2 = −r_1); the spec
 * does not yet define the outcome of that case (reported to the spec owner).
 */
export function tallyStatement(ctx: ProofContext, y: Point, T: Point, D: Point): Statement {
  nonId(y, 'tallyStatement', 'y');
  nonId(T, 'tallyStatement', 'T');
  nonId(D, 'tallyStatement', 'D');
  return { proofType: 'tally', ctx, aux: EMPTY, branches: [{ nWitness: 1, eqs: [eq(y, [0, G]), eq(D, [0, T])] }] };
}

/** open: y_a = x·G; O_a = x·A_a. Witness [x]. */
export function openStatement(ctx: ProofContext, y: Point, A: Point, Oa: Point): Statement {
  nonId(y, 'openStatement', 'y');
  nonId(A, 'openStatement', 'A');
  nonId(Oa, 'openStatement', 'O_a');
  return { proofType: 'open', ctx, aux: EMPTY, branches: [{ nWitness: 1, eqs: [eq(y, [0, G]), eq(Oa, [0, A])] }] };
}

/**
 * Builds the lazily computed fixed-base tables of G and of every global
 * generator (§7.5: "provers precompute fixed-base tables ... once"), for both
 * the constant-time and the public-data multiply. Without it the first proof a
 * fresh crypto worker builds pays for every table it touches (about 0.4 s for
 * a shuffle, which uses all H_i). Uses a fixed public scalar; idempotent.
 */
export function warmUpTables(): void {
  const k = 0x5a17_0000_0000_0000_0000_0000_0000_0001n;
  for (const P of [G, GEN.S, GEN.J, GEN.H0, ...GEN.H, NEG_J]) {
    mul(P, k);
    mulPub(P, k);
  }
}
