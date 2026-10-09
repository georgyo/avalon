/**
 * The ristretto255 group (§2.1-2.4): point/scalar codecs, scalar
 * multiplication, MSM, hash-to-group, and the global generators.
 */
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { mulAddUnsafe, pippenger } from '@noble/curves/abstract/curve.js';
import { CodecError, b64uDecode, b64uEncode, randomBytes, utf8, type RandomSource } from './bytes.ts';
import type { Pt, Sc } from './types.ts';

export type Point = InstanceType<typeof ristretto255.Point>;
export type Scalar = bigint;

/** Thrown on invalid group operations (out-of-range scalars, zero secret scalar, ...). */
export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

const PointCls = ristretto255.Point;

/** Generator. */
export const G: Point = PointCls.BASE;
/** Identity. */
export const O: Point = PointCls.ZERO;
/** Group order L = 2^252 + 27742317777372353535851937790883648493. */
export const L: bigint = PointCls.Fn.ORDER;

/** Reduces any bigint into [0, L). */
export function mod(x: bigint): Scalar {
  const r = x % L;
  return r < 0n ? r + L : r;
}

// ---------------------------------------------------------------- points

/** Points are immutable, so their 32-byte encodings can be cached. */
const encCache = new WeakMap<Point, Uint8Array>();

function isPoint(P: unknown): P is Point {
  return P instanceof PointCls;
}

/**
 * 32-byte RFC 9496 encoding (identity = 32 zero bytes), the shared cached array.
 * Internal to common/crypto (not re-exported by index.ts): callers must never mutate
 * the result, since it is the encoding used for every transcript of that point.
 * Everything outside this directory uses ptBytes (a fresh copy).
 */
export function ptBytesShared(P: Point): Uint8Array {
  let b = encCache.get(P);
  if (b === undefined) {
    if (!isPoint(P)) throw new CryptoError('not a ristretto255 point');
    b = P.toBytes();
    encCache.set(P, b);
  }
  return b;
}

/** 32-byte RFC 9496 encoding of P (a fresh copy). */
export function ptBytes(P: Point): Uint8Array {
  return ptBytesShared(P).slice();
}

export function encPoint(P: Point): Pt {
  return b64uEncode(ptBytesShared(P));
}

/** Decodes a 32-byte encoding; rejects the identity unless allowed. Throws CodecError. */
export function ptFromBytes(b: Uint8Array, opts?: { allowIdentity?: boolean }): Point {
  if (!(b instanceof Uint8Array) || b.length !== 32) throw new CodecError('point: expected 32 bytes');
  let P: Point;
  try {
    P = PointCls.fromBytes(b);
  } catch {
    throw new CodecError('point: invalid ristretto255 encoding');
  }
  if (!opts?.allowIdentity && P.is0()) throw new CodecError('point: identity not allowed');
  encCache.set(P, b.slice());
  return P;
}

/** Strict point decoder (§2.2); rejects the identity by default (§2.3). Throws CodecError. */
export function decPoint(s: Pt, opts?: { allowIdentity?: boolean }): Point {
  return ptFromBytes(b64uDecode(s, 32), opts);
}

// ---------------------------------------------------------------- scalars

function scalarFromLE(b: Uint8Array): bigint {
  let x = 0n;
  for (let i = b.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i]);
  return x;
}

/** 32-byte little-endian encoding of a scalar in [0, L). */
export function scalarBytes(x: Scalar): Uint8Array {
  if (typeof x !== 'bigint' || x < 0n || x >= L) throw new CryptoError('scalar out of range');
  const out = new Uint8Array(32);
  let v = x;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function encScalar(x: Scalar): Sc {
  return b64uEncode(scalarBytes(x));
}

/** Strict scalar decoder: 32 bytes little-endian, value < L. Throws CodecError. */
export function decScalar(s: Sc): Scalar {
  const x = scalarFromLE(b64uDecode(s, 32));
  if (x >= L) throw new CodecError('scalar: value >= L');
  return x;
}

/** Big-endian bytes to bigint. */
export function bigFromBE(b: Uint8Array): bigint {
  let x = 0n;
  for (let i = 0; i < b.length; i++) x = (x << 8n) | BigInt(b[i]);
  return x;
}

// ---------------------------------------------------------------- arithmetic

/** Secret scalar multiplication: constant-time `multiply`, requires 0 < k < L. */
export function mul(P: Point, k: Scalar): Point {
  if (typeof k !== 'bigint' || k <= 0n || k >= L) throw new CryptoError('mul: secret scalar must satisfy 0 < k < L');
  return P.multiply(k);
}

/** Public-data multiplication (`multiplyUnsafe`); allows k = 0. */
export function mulPub(P: Point, k: Scalar): Point {
  if (typeof k !== 'bigint' || k < 0n || k >= L) throw new CryptoError('mulPub: scalar must satisfy 0 <= k < L');
  if (k === 0n) return O;
  return P.multiplyUnsafe(k);
}

/**
 * Multi-scalar multiplication Σ scalars[i]·points[i] over public data.
 * Measured on noble 2.4, interleaved wNAF (Strauss, `mulAddUnsafe`) beats
 * `pippenger` below a few thousand points, so it is used up to MSM_STRAUSS_MAX.
 */
export function msm(points: Point[], scalars: Scalar[]): Point {
  if (points.length !== scalars.length) throw new CryptoError('msm: length mismatch');
  if (points.length === 0) return O;
  for (const k of scalars) {
    if (typeof k !== 'bigint' || k < 0n || k >= L) throw new CryptoError('msm: scalar out of range');
  }
  return points.length <= MSM_STRAUSS_MAX ? mulAddUnsafe(PointCls, points, scalars) : pippenger(PointCls, points, scalars);
}

const MSM_STRAUSS_MAX = 80;

// ---------------------------------------------------------------- hashing to the group

/** hash_to_ristretto255 (RFC 9380 / RFC 9496) with DST = utf8(tag). */
export function H2C(tag: string, msg: Uint8Array): Point {
  return ristretto255_hasher.hashToCurve(msg, { DST: utf8(tag) });
}

/** expand_message_xmd(SHA-512) to 64 bytes, little-endian, reduced mod L; DST = utf8(tag). */
export function H2S(tag: string, msg: Uint8Array): Scalar {
  return ristretto255_hasher.hashToScalar(msg, { DST: utf8(tag) });
}

// ---------------------------------------------------------------- generators

const GEN_TAG = 'avalon-p2p/v1/gen';
/** Number of shuffle generators H_i (max deck size, §5.3). */
export const MAX_DECK = 10;

function generator(label: string): Point {
  // Lazy fixed-base precomputation: the table is built on the first constant-time multiply.
  return H2C(GEN_TAG, utf8(label)).precompute(8, true);
}

/** Global generators (§2.4); nobody knows a discrete-log relation between them and G. */
export const GEN: { S: Point; J: Point; H0: Point; H: readonly Point[] } = Object.freeze({
  S: generator('ot-S'),
  J: generator('ot-J'),
  H0: generator('shuffle-H'),
  H: Object.freeze(Array.from({ length: MAX_DECK }, (_, i) => generator('shuffle-H/' + i))),
});

// ---------------------------------------------------------------- misc

/** Returns k with P = k·G for 0 <= k <= max, or null. Public data only. */
export function smallLog(P: Point, max: number): number | null {
  let Q = O;
  for (let k = 0; k <= max; k++) {
    if (Q.equals(P)) return k;
    Q = Q.add(G);
  }
  return null;
}

/**
 * A fresh nonzero 128-bit batch weight from getRandomValues (§2.5: never derived,
 * never injectable in production, so a prover cannot predict it).
 */
export function randomWeight128(): Scalar {
  return randomWeight128From(randomBytes);
}

/**
 * Internal (not re-exported by index.ts): the same with an explicit byte source,
 * for deterministic tests only. Production code must use randomWeight128().
 */
export function randomWeight128From(rng: RandomSource): Scalar {
  for (;;) {
    const b = rng(16);
    if (b.length !== 16) throw new CryptoError('random source returned the wrong length');
    const z = bigFromBE(b);
    if (z !== 0n) return z;
  }
}
