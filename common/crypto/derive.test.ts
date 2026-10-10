import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extract } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 as nobleSha256, sha512 as nobleSha512 } from '@noble/hashes/sha2.js';
import { concat, hexEncode, lp, u32, utf8 } from './bytes.ts';
import { CryptoError, G, L, bigFromBE, encScalar, mod, ptBytes } from './group.ts';
import { deriveStream, type SeedRef } from './derive.ts';
import { seedFor } from './testkit.ts';

const seed: SeedRef = seedFor(0);

/** Independent recomputation of blk_t from the §2.5 formula. */
function block(s: SeedRef, purpose: string, ctx: Uint8Array[], t: number): Uint8Array {
  const prk = extract(nobleSha256, s.gameSeed, utf8('avalon-p2p/v1/derive'));
  return hmac(nobleSha512, prk, concat(lp(utf8(s.gameId)), lp(utf8(purpose)), ...ctx.map(lp), u32(t)));
}

test('stream matches the §2.5 formula (independent recomputation)', () => {
  const st = deriveStream(seed, 'ot-k', 3, 1, G, 'abc', Uint8Array.of(7));
  const ctx = [u32(3), u32(1), ptBytes(G), utf8('abc'), Uint8Array.of(7)];
  const b0 = block(seed, 'ot-k', ctx, 0);
  const b1 = block(seed, 'ot-k', ctx, 1);
  assert.equal(st.scalar(), mod(bigFromBE(b0)));
  assert.equal(st.index(1000), Number(bigFromBE(b1) % 1000n));
  const bs = deriveStream(seed, 'seed');
  assert.deepEqual(bs.bytes(32), block(seed, 'seed', [], 0).slice(0, 32));
});

test('pinned known answers', () => {
  assert.equal(encScalar(deriveStream(seed, 'x').scalar()), '_eiOB0ampQL5MhQEj24XHdSjOGa89-LxsPtX1H5qRg0');
  assert.equal(hexEncode(deriveStream(seed, 'seed').bytes(32)), 'fc32352453867a67112a8c100e4a4da65e22d1ebecf32c4a1f0759119028e7b9');
  assert.deepEqual(deriveStream(seed, 'p', 1, 'a').perm(10), [9, 0, 2, 5, 7, 4, 3, 1, 8, 6]);
});

test('determinism and separation', () => {
  const a = deriveStream(seed, 'x').scalar();
  assert.equal(deriveStream(seed, 'x').scalar(), a);
  assert.notEqual(deriveStream(seed, 'y').scalar(), a);
  assert.notEqual(deriveStream(seedFor(1), 'x').scalar(), a);
  assert.notEqual(deriveStream({ gameSeed: seed.gameSeed, gameId: 'other' }, 'x').scalar(), a);
  assert.notEqual(deriveStream(seed, 'x', 0).scalar(), a);
  // context items are length-prefixed: ("ab","c") != ("a","bc")
  assert.notEqual(deriveStream(seed, 'p', 'ab', 'c').scalar(), deriveStream(seed, 'p', 'a', 'bc').scalar());
  // equal bytes give equal streams, whatever the item type
  assert.equal(deriveStream(seed, 'p', 'abc').scalar(), deriveStream(seed, 'p', utf8('abc')).scalar());
  assert.equal(deriveStream(seed, 'p', 5).scalar(), deriveStream(seed, 'p', u32(5)).scalar());
  assert.equal(deriveStream(seed, 'p', G).scalar(), deriveStream(seed, 'p', ptBytes(G)).scalar());
});

test('bytes reads the concatenated blocks; scalar and index take whole blocks', () => {
  const whole = deriveStream(seed, 'b').bytes(200);
  const st = deriveStream(seed, 'b');
  const parts = concat(st.bytes(10), st.bytes(54), st.bytes(0), st.bytes(100), st.bytes(36));
  assert.deepEqual(parts, whole);
  // after a partial block, scalar() starts at the next block
  const st2 = deriveStream(seed, 'b');
  st2.bytes(10);
  assert.equal(st2.scalar(), mod(bigFromBE(whole.slice(64, 128))));
});

test('scalar range, index range, perm is a permutation', () => {
  const st = deriveStream(seed, 'r');
  for (let i = 0; i < 50; i++) {
    const s = st.scalar();
    assert.ok(s > 0n && s < L);
  }
  for (const m of [1, 2, 7, 1000, 0xffffffff]) {
    const v = st.index(m);
    assert.ok(Number.isInteger(v) && v >= 0 && v < m);
  }
  for (const n of [0, 1, 2, 5, 10]) {
    const p = deriveStream(seed, 'perm', n).perm(n);
    assert.deepEqual([...p].sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i));
  }
  assert.throws(() => st.index(0), CryptoError);
  assert.throws(() => st.bytes(-1), CryptoError);
});

test('Fisher-Yates follows the spec order of index() calls', () => {
  const n = 6;
  const st = deriveStream(seed, 'fy');
  const p = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i >= 1; i--) {
    const j = st.index(i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  assert.deepEqual(deriveStream(seed, 'fy').perm(n), p);
});

test('seed must be 32 bytes', () => {
  assert.throws(() => deriveStream({ gameSeed: new Uint8Array(16), gameId: 'g' }, 'x'), CryptoError);
});
