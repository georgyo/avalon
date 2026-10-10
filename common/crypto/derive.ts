/**
 * Reload-safe deterministic secret derivation (§2.5).
 *
 *   PRK   = HKDF-Extract(SHA-256, salt = utf8("avalon-p2p/v1/derive"), ikm = gs_j)
 *   blk_t = HMAC-SHA-512(PRK, lp(utf8(gameId)) ‖ lp(utf8(purpose)) ‖ lp(ctx_1) ‖ ... ‖ u32(t))
 *
 * Reading rules: `scalar()` and `index(m)` consume the next whole 64-byte block
 * (discarding the unread rest of a block partially consumed by `bytes`);
 * `bytes(k)` reads the next k bytes of the concatenated blocks. For every use
 * in the spec (bytes alone, or only block reads) both readings coincide.
 *
 * Context items: a `number` is ALWAYS encoded as u32. Where §2.5 specifies a
 * u8 (the ballot stream's u8(v)), pass a 1-byte Uint8Array, or use
 * ballotRandomness() below.
 *
 * The context binds gameId, not configId (§2.5). Fork safety therefore rests
 * on the seed store: gs_j MUST be keyed by (gameId, configId) and a seat MUST
 * NOT sign under a second configId for a gameId it already holds a seed for;
 * otherwise x_j, β_Q, f_r and seed_j would repeat across the two configs.
 */
import { extract } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 as nobleSha256, sha512 as nobleSha512 } from '@noble/hashes/sha2.js';
import { concat, lp, u32, u8, utf8 } from './bytes.ts';
import { CryptoError, L, bigFromBE, ptBytesShared, type Point, type Scalar } from './group.ts';
import { ristretto255 } from '@noble/curves/ed25519.js';

/** Context item: strings are utf8, integers u32, points their 32-byte encoding, bytes as is. */
export type CtxItem = string | number | Uint8Array | Point;

export interface Stream {
  /** Next 64-byte block as a big-endian integer mod L; a zero result takes the next block. */
  scalar(): Scalar;
  /** Next k bytes of the concatenated blocks. */
  bytes(k: number): Uint8Array;
  /** Next 64-byte block as a big-endian integer mod m (1 <= m < 2^32). */
  index(m: number): number;
  /** Fisher-Yates permutation of [0..n-1] driven by index(). */
  perm(n: number): number[];
}

export interface SeedRef { gameSeed: Uint8Array; gameId: string }

const SALT = utf8('avalon-p2p/v1/derive');

function ctxBytes(c: CtxItem): Uint8Array {
  if (typeof c === 'string') return utf8(c);
  if (typeof c === 'number') return u32(c);
  if (c instanceof Uint8Array) return c;
  if (c instanceof ristretto255.Point) return ptBytesShared(c);
  throw new CryptoError('deriveStream: unsupported context item');
}

/** Creates the derivation stream `stream(purpose, ctx...)` of §2.5 for one seat's per-game seed. */
export function deriveStream(seed: SeedRef, purpose: string, ...ctx: CtxItem[]): Stream {
  if (!(seed.gameSeed instanceof Uint8Array) || seed.gameSeed.length !== 32) {
    throw new CryptoError('deriveStream: the game seed must be 32 bytes');
  }
  if (typeof seed.gameId !== 'string') throw new CryptoError('deriveStream: gameId must be a string');
  const prk = extract(nobleSha256, seed.gameSeed, SALT);
  const prefix = concat(lp(utf8(seed.gameId)), lp(utf8(purpose)), ...ctx.map((c) => lp(ctxBytes(c))));
  const mac = hmac.create(nobleSha512, prk).update(prefix);

  let t = 0;
  let buf: Uint8Array = new Uint8Array(0);
  let pos = 0;

  const nextBlock = (): Uint8Array => {
    if (t > 0xffffffff) throw new CryptoError('deriveStream: exhausted');
    const blk = mac.clone().update(u32(t)).digest();
    t++;
    return blk;
  };
  const wholeBlock = (): Uint8Array => {
    // Discard any partially consumed block, then read the next one.
    buf = new Uint8Array(0);
    pos = 0;
    return nextBlock();
  };

  const stream: Stream = {
    scalar(): Scalar {
      for (;;) {
        const x = bigFromBE(wholeBlock()) % L;
        if (x !== 0n) return x;
      }
    },
    bytes(k: number): Uint8Array {
      if (!Number.isInteger(k) || k < 0) throw new CryptoError('deriveStream.bytes: invalid length');
      const out = new Uint8Array(k);
      let o = 0;
      while (o < k) {
        if (pos >= buf.length) {
          buf = nextBlock();
          pos = 0;
        }
        const take = Math.min(k - o, buf.length - pos);
        out.set(buf.subarray(pos, pos + take), o);
        o += take;
        pos += take;
      }
      return out;
    },
    index(m: number): number {
      if (!Number.isInteger(m) || m < 1 || m > 0xffffffff) throw new CryptoError('deriveStream.index: invalid modulus');
      return Number(bigFromBE(wholeBlock()) % BigInt(m));
    },
    perm(n: number): number[] {
      if (!Number.isInteger(n) || n < 0) throw new CryptoError('deriveStream.perm: invalid size');
      const p = Array.from({ length: n }, (_, i) => i);
      for (let i = n - 1; i >= 1; i--) {
        const j = stream.index(i + 1);
        const tmp = p[i];
        p[i] = p[j];
        p[j] = tmp;
      }
      return p;
    },
  };
  return stream;
}

/**
 * Ballot randomness r of §2.5: stream("ballot", utf8(stepId), prev, u8(v)).scalar().
 * prev is the 32-byte step digest; v the ballot value (encoded as u8, not u32).
 */
export function ballotRandomness(seed: SeedRef, stepId: string, prev: Uint8Array, v: 0 | 1): Scalar {
  if (!(prev instanceof Uint8Array) || prev.length !== 32) throw new CryptoError('ballotRandomness: prev must be 32 bytes');
  if (v !== 0 && v !== 1) throw new CryptoError('ballotRandomness: v must be 0 or 1');
  return deriveStream(seed, 'ballot', stepId, prev, u8(v)).scalar();
}
