/**
 * Verifiable 1-of-R oblivious transfer for the sight exchange (§5.5).
 */
import { CryptoError, G, GEN, O, mul, mulPub, type Point, type Scalar } from './group.ts';
import { deriveStream, type SeedRef } from './derive.ts';
import type { Ct } from './elgamal.ts';

/** Indexable [O, G]: the point s·G for a secret bit s without branching on it. */
const BIT_POINTS: readonly Point[] = [O, G];

function checkIndex(c: number): void {
  if (!Number.isInteger(c) || c < 0 || c > 0xffff) throw new CryptoError('ot: invalid index');
}

/** Receiver choice commitment U = β·G + c·S (c secret; both multiplications are constant-time). */
export function otChoice(beta: Scalar, c: number): Point {
  checkIndex(c);
  // c·S = (c+1)·S − S keeps the multiplication constant-time also for c = 0.
  const cS = mul(GEN.S, BigInt(c + 1)).subtract(GEN.S);
  return mul(G, beta).add(cS);
}

/** PK_{Q,r} = U_Q − r·S (public). */
export function otPk(U: Point, r: number): Point {
  checkIndex(r);
  return U.subtract(mulPub(GEN.S, BigInt(r)));
}

/**
 * Sender messages of seat `self` (§5.5):
 *   F_r     = (f_r·G, s_r·G + f_r·J),            f_r     = stream("ot-f", r)
 *   E_{Q,r} = (k·G,   s_r·G + k·PK_{Q,r}),       k_{Q,r} = stream("ot-k", Q, r, U_Q)
 * U[Q] must be present for every Q ≠ self, and no PK_{Q,r} may be the identity
 * (throws). Returns the secrets f and k for the proofs.
 */
export function otSenderMessages(seed: SeedRef, bits: (0 | 1)[], U: (Point | null)[], self: number):
  { F: Ct[]; E: (Ct[] | null)[]; f: Scalar[]; k: (Scalar[] | null)[] } {
  const R = bits.length;
  if (R < 1) throw new CryptoError('otSenderMessages: empty profile');
  if (!Number.isInteger(self) || self < 0 || self >= U.length) throw new CryptoError('otSenderMessages: invalid seat');
  for (const s of bits) if (s !== 0 && s !== 1) throw new CryptoError('otSenderMessages: bits must be 0 or 1');

  const f: Scalar[] = [];
  const F: Ct[] = [];
  for (let r = 0; r < R; r++) {
    const fr = deriveStream(seed, 'ot-f', r).scalar();
    f.push(fr);
    F.push({ a: mul(G, fr), b: BIT_POINTS[bits[r]].add(mul(GEN.J, fr)) });
  }
  const E: (Ct[] | null)[] = [];
  const k: (Scalar[] | null)[] = [];
  for (let Q = 0; Q < U.length; Q++) {
    if (Q === self) {
      E.push(null);
      k.push(null);
      continue;
    }
    const UQ = U[Q];
    if (UQ === null) throw new CryptoError('otSenderMessages: missing receiver commitment');
    const row: Ct[] = [];
    const krow: Scalar[] = [];
    let PK = UQ;
    for (let r = 0; r < R; r++) {
      if (r > 0) PK = PK.subtract(GEN.S);
      // Defense in depth (otRecvStatement already rejects U_Q = r·S): with PK = O,
      // E_{Q,r} = (k·G, s_r·G) would carry the sight bit in clear.
      if (PK.is0()) throw new CryptoError('otSenderMessages: degenerate receiver key PK = O');
      const kqr = deriveStream(seed, 'ot-k', Q, r, UQ).scalar();
      krow.push(kqr);
      row.push({ a: mul(G, kqr), b: BIT_POINTS[bits[r]].add(mul(PK, kqr)) });
    }
    E.push(row);
    k.push(krow);
  }
  return { F, E, f, k };
}

/** Receiver decoding X = e.b − β·e.a: 0 if X = O, 1 if X = G, null otherwise. */
export function otDecode(beta: Scalar, e: Ct): 0 | 1 | null {
  const X = e.b.subtract(mul(e.a, beta));
  if (X.is0()) return 0;
  if (X.equals(G)) return 1;
  return null;
}
