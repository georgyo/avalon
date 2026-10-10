/**
 * Encoded primitive types shared by every package (§2.2, §3.2).
 * common/protocol/types.ts (WP-B) re-exports them.
 */

/** 43-char unpadded base64url encoding of a 32-byte ristretto255 point (RFC 9496). */
export type Pt = string;
/** 43-char unpadded base64url encoding of a 32-byte little-endian scalar < L. */
export type Sc = string;
/** 64 lowercase hex chars (a 32-byte digest or msgId). */
export type Hex32 = string;
/** Unpadded base64url bytes. */
export type B64 = string;
/** SEA public key "x.y" (two 43-char base64url P-256 coordinates). */
export type Pub = string;

/** Encoded ElGamal ciphertext (A, B). */
export interface CtE { a: Pt; b: Pt }
/** Encoded sigma proof (§2.6.3): K per branch per equation, e per branch, s per branch per witness. */
export interface SigmaProofE { K: Pt[][]; e: Sc[]; s: Sc[][] }
/** A card label λ (§2.4). */
export interface CardLabel { role: string; assassin: boolean }
