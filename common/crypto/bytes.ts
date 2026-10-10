/**
 * Byte utilities, strict codecs, hashing and canonical JSON (§2.2).
 * Pure and synchronous; no protocol knowledge.
 */
import { sha256 as nobleSha256, sha512 as nobleSha512 } from '@noble/hashes/sha2.js';

/** Thrown by every strict decoder / encoder on malformed input. */
export class CodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodecError';
  }
}

const textEncoder = new TextEncoder();

export function utf8(s: string): Uint8Array {
  return textEncoder.encode(s);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function u8(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xff) throw new CodecError(`u8 out of range: ${n}`);
  return Uint8Array.of(n);
}

/** Big-endian 32-bit unsigned integer. */
export function u32(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new CodecError(`u32 out of range: ${n}`);
  return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

/** Length-prefixed bytes: u32(len(b)) ‖ b. */
export function lp(b: Uint8Array): Uint8Array {
  return concat(u32(b.length), b);
}

// ---------------------------------------------------------------- base64url

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_LOOKUP: Int16Array = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) t[B64_ALPHABET.charCodeAt(i)] = i;
  return t;
})();

/** Unpadded base64url. */
export function b64uEncode(b: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 3 <= b.length; i += 3) {
    const v = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += B64_ALPHABET[(v >>> 18) & 63] + B64_ALPHABET[(v >>> 12) & 63] + B64_ALPHABET[(v >>> 6) & 63] + B64_ALPHABET[v & 63];
  }
  const rem = b.length - i;
  if (rem === 1) {
    const v = b[i] << 16;
    out += B64_ALPHABET[(v >>> 18) & 63] + B64_ALPHABET[(v >>> 12) & 63];
  } else if (rem === 2) {
    const v = (b[i] << 16) | (b[i + 1] << 8);
    out += B64_ALPHABET[(v >>> 18) & 63] + B64_ALPHABET[(v >>> 12) & 63] + B64_ALPHABET[(v >>> 6) & 63];
  }
  return out;
}

/**
 * Strict unpadded base64url decoder: only [A-Za-z0-9_-], no padding, no
 * whitespace, and the input must re-encode to the identical string (unused
 * trailing bits are zero). Optionally checks the decoded length.
 */
export function b64uDecode(s: string, expectedLen?: number): Uint8Array {
  if (typeof s !== 'string') throw new CodecError('base64url: not a string');
  if (s.length % 4 === 1) throw new CodecError('base64url: invalid length');
  const outLen = (s.length * 3) >> 2;
  if (expectedLen !== undefined && outLen !== expectedLen) {
    throw new CodecError(`base64url: expected ${expectedLen} bytes, got ${outLen}`);
  }
  const vals = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64_LOOKUP[c] : -1;
    if (v < 0) throw new CodecError('base64url: invalid character');
    vals[i] = v;
  }
  const out = new Uint8Array(outLen);
  let o = 0;
  let i = 0;
  for (; i + 4 <= s.length; i += 4) {
    const v = (vals[i] << 18) | (vals[i + 1] << 12) | (vals[i + 2] << 6) | vals[i + 3];
    out[o++] = (v >>> 16) & 0xff;
    out[o++] = (v >>> 8) & 0xff;
    out[o++] = v & 0xff;
  }
  const rem = s.length - i;
  if (rem === 2) {
    const v = (vals[i] << 18) | (vals[i + 1] << 12);
    if (v & 0xffff) throw new CodecError('base64url: non-canonical trailing bits');
    out[o] = (v >>> 16) & 0xff;
  } else if (rem === 3) {
    const v = (vals[i] << 18) | (vals[i + 1] << 12) | (vals[i + 2] << 6);
    if (v & 0xff) throw new CodecError('base64url: non-canonical trailing bits');
    out[o] = (v >>> 16) & 0xff;
    out[o + 1] = (v >>> 8) & 0xff;
  }
  // Defense in depth: the encoding must be canonical.
  if (b64uEncode(out) !== s) throw new CodecError('base64url: non-canonical');
  return out;
}

// ---------------------------------------------------------------- hex

const HEX = '0123456789abcdef';

export function hexEncode(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i++) out += HEX[b[i] >>> 4] + HEX[b[i] & 15];
  return out;
}

/** Strict lowercase hex decoder. */
export function hexDecode(s: string, expectedLen?: number): Uint8Array {
  if (typeof s !== 'string') throw new CodecError('hex: not a string');
  if (s.length % 2 !== 0) throw new CodecError('hex: odd length');
  if (!/^[0-9a-f]*$/.test(s)) throw new CodecError('hex: invalid character (lowercase only)');
  const n = s.length / 2;
  if (expectedLen !== undefined && n !== expectedLen) throw new CodecError(`hex: expected ${expectedLen} bytes, got ${n}`);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

// ---------------------------------------------------------------- hashes

export function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = nobleSha256.create();
  for (const p of parts) h.update(p);
  return h.digest();
}

export function sha512(...parts: Uint8Array[]): Uint8Array {
  const h = nobleSha512.create();
  for (const p of parts) h.update(p);
  return h.digest();
}

// ---------------------------------------------------------------- canonical JSON

function canonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) throw new CodecError('canon: string contains a non-printable or non-ASCII character');
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else out += s[i];
  }
  return out + '"';
}

function canonValue(v: unknown, stack: object[]): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(v)) throw new CodecError('canon: numbers must be integers with |x| < 2^53');
      return Object.is(v, -0) ? '0' : String(v);
    case 'string':
      return canonString(v);
    case 'object': {
      if (stack.includes(v)) throw new CodecError('canon: cyclic value');
      if (stack.length >= 64) throw new CodecError('canon: nesting too deep');
      stack.push(v);
      try {
        if (Array.isArray(v)) {
          const items: string[] = [];
          for (let i = 0; i < v.length; i++) {
            const item: unknown = v[i];
            if (item === undefined) throw new CodecError('canon: undefined array element');
            items.push(canonValue(item, stack));
          }
          return '[' + items.join(',') + ']';
        }
        const proto: unknown = Object.getPrototypeOf(v);
        if (proto !== Object.prototype && proto !== null) throw new CodecError('canon: only plain objects are allowed');
        const rec = v as Record<string, unknown>;
        const keys = Object.keys(rec).sort();
        const members: string[] = [];
        for (const k of keys) {
          const item = rec[k];
          if (item === undefined) continue; // JSON semantics: absent
          members.push(canonString(k) + ':' + canonValue(item, stack));
        }
        return '{' + members.join(',') + '}';
      } finally {
        stack.pop();
      }
    }
    default:
      throw new CodecError(`canon: unsupported type ${typeof v}`);
  }
}

/**
 * Canonical JSON (§2.2): keys sorted by UTF-16 code unit, no whitespace,
 * printable-ASCII strings with only `"` and `\` escaped, safe integers only.
 * Object members whose value is `undefined` are omitted (as in JSON);
 * everything else that is not JSON (undefined array items, bigint, functions,
 * class instances, cycles) throws CodecError.
 */
export function canon(v: unknown): string {
  return canonValue(v, []);
}

/**
 * Parses canonical JSON; rejects anything for which canon(JSON.parse(s)) !== s
 * (whitespace, escapes, non-integers, unsorted or duplicate keys, ...).
 * Per-type schemas (unknown/missing keys) are the caller's job (§3.3).
 */
export function parseCanon(s: string): unknown {
  if (typeof s !== 'string') throw new CodecError('parseCanon: not a string');
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    throw new CodecError('parseCanon: invalid JSON');
  }
  if (canon(v) !== s) throw new CodecError('parseCanon: not canonical');
  return v;
}

// ---------------------------------------------------------------- randomness

/** Cryptographically secure random bytes (crypto.getRandomValues). */
export function randomBytes(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) throw new CodecError(`randomBytes: invalid length ${n}`);
  const out = new Uint8Array(n);
  for (let off = 0; off < n; off += 65536) {
    globalThis.crypto.getRandomValues(out.subarray(off, Math.min(n, off + 65536)));
  }
  return out;
}

/** Source of random bytes; tests inject a deterministic one. */
export type RandomSource = (n: number) => Uint8Array;
