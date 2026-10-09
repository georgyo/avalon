import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CodecError, b64uDecode, b64uEncode, canon, concat, hexDecode, hexEncode, lp, parseCanon, randomBytes, sha256, sha512,
  u32, u8, utf8,
} from './bytes.ts';
import { seededRandom } from './testkit.ts';

test('utf8, concat, u8, u32 (big-endian), lp', () => {
  assert.deepEqual([...utf8('Aé')], [0x41, 0xc3, 0xa9]);
  assert.deepEqual([...concat(Uint8Array.of(1), new Uint8Array(0), Uint8Array.of(2, 3))], [1, 2, 3]);
  assert.deepEqual([...u8(255)], [255]);
  assert.deepEqual([...u32(0x01020304)], [1, 2, 3, 4]);
  assert.deepEqual([...u32(0xffffffff)], [255, 255, 255, 255]);
  assert.deepEqual([...lp(Uint8Array.of(9, 8))], [0, 0, 0, 2, 9, 8]);
  for (const bad of [-1, 256, 1.5, NaN]) assert.throws(() => u8(bad), CodecError);
  for (const bad of [-1, 2 ** 32, 0.5]) assert.throws(() => u32(bad), CodecError);
});

test('base64url: RFC 4648 vectors (unpadded, url alphabet)', () => {
  const vectors: [string, string][] = [
    ['', ''], ['f', 'Zg'], ['fo', 'Zm8'], ['foo', 'Zm9v'], ['foob', 'Zm9vYg'], ['fooba', 'Zm9vYmE'], ['foobar', 'Zm9vYmFy'],
  ];
  for (const [plain, enc] of vectors) {
    assert.equal(b64uEncode(utf8(plain)), enc);
    assert.deepEqual(b64uDecode(enc), utf8(plain));
  }
  assert.equal(b64uEncode(Uint8Array.of(0xfb, 0xff, 0xfe)), '-__-');
  assert.deepEqual([...b64uDecode('-__-')], [0xfb, 0xff, 0xfe]);
});

test('base64url: random round trips', () => {
  const rng = seededRandom(1);
  for (let n = 0; n < 70; n++) {
    const b = rng(n);
    const s = b64uEncode(b);
    assert.match(s, /^[A-Za-z0-9_-]*$/);
    assert.deepEqual(b64uDecode(s, n), b);
  }
});

test('base64url: strict rejections', () => {
  const bad = [
    'Zg==', 'Zg=', // padding
    'Zm9v+A', 'Zm9v/A', // standard alphabet
    'Zm9 v', 'Zm9v\n', // whitespace
    'A', 'AAAAA', // impossible length
    'Zh', 'Zm9', 'Zm-', // non-zero trailing bits (non-canonical)
    'Zm9vé',
  ];
  for (const s of bad) assert.throws(() => b64uDecode(s), CodecError, s);
  assert.throws(() => b64uDecode('Zm9v', 4), CodecError);
  assert.deepEqual(b64uDecode('Zm9v', 3), utf8('foo'));
  assert.throws(() => b64uDecode(42 as unknown as string), CodecError);
});

test('hex: strict lowercase', () => {
  assert.equal(hexEncode(Uint8Array.of(0, 0xab, 0xff)), '00abff');
  assert.deepEqual([...hexDecode('00abff')], [0, 0xab, 0xff]);
  assert.deepEqual(hexDecode('', 0), new Uint8Array(0));
  for (const s of ['00ABFF', 'abc', '0g', ' 00', '0x00']) assert.throws(() => hexDecode(s), CodecError, s);
  assert.throws(() => hexDecode('00', 2), CodecError);
});

test('sha256 / sha512 known answers and multi-part', () => {
  assert.equal(hexEncode(sha256(utf8('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(
    hexEncode(sha512(utf8('abc'))),
    'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
  );
  assert.deepEqual(sha256(utf8('a'), utf8('bc')), sha256(utf8('abc')));
  assert.deepEqual(sha512(utf8('ab'), new Uint8Array(0), utf8('c')), sha512(utf8('abc')));
});

test('canon: vectors', () => {
  const vectors: [unknown, string][] = [
    [null, 'null'],
    [true, 'true'],
    [false, 'false'],
    [0, '0'],
    [-0, '0'],
    [-17, '-17'],
    [2 ** 53 - 1, '9007199254740991'],
    [-(2 ** 53 - 1), '-9007199254740991'],
    ['', '""'],
    ['a"b\\c', '"a\\"b\\\\c"'],
    ['~ !', '"~ !"'],
    [[], '[]'],
    [{}, '{}'],
    [[1, 'x', [null]], '[1,"x",[null]]'],
    [{ b: 1, a: 2, B: 3, _: 4, '': 5 }, '{"":5,"B":3,"_":4,"a":2,"b":1}'],
    [{ z: { y: [{ b: true, a: false }] } }, '{"z":{"y":[{"a":false,"b":true}]}}'],
    [{ a: undefined, b: 1 }, '{"b":1}'],
    [{ v: 1, type: 'key', body: { y: 'abc' } }, '{"body":{"y":"abc"},"type":"key","v":1}'],
  ];
  for (const [v, s] of vectors) assert.equal(canon(v), s);
  const nullProto: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  nullProto.k = 1;
  assert.equal(canon(nullProto), '{"k":1}');
});

test('canon: rejections', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  class K { a = 1; }
  const bad: unknown[] = [
    1.5, NaN, Infinity, -Infinity, 2 ** 53, -(2 ** 53), 1e21,
    'café', 'line\nbreak', 'tab\t', '\u007f',
    { 'kéy': 1 },
    [undefined], [1, () => 1],
    10n, Symbol('s'), undefined, () => 1,
    new Map(), new Date(0), new Uint8Array(1), new K(),
    cyclic,
  ];
  for (const v of bad) assert.throws(() => canon(v), CodecError, String(typeof v));
});

test('parseCanon: accepts exactly canonical text', () => {
  for (const s of ['null', '0', '-5', '"x"', '[]', '{}', '{"a":[1,{"b":"c"}],"b":null}', '{"__proto__":1}']) {
    assert.equal(canon(parseCanon(s)), s);
  }
  const bad = [
    '', ' 1', '1 ', '{"a": 1}', '[1, 2]', // whitespace
    '{"b":1,"a":2}', // unsorted
    '{"a":1,"a":2}', '{"a":1,"a":1}', // duplicate keys
    '"\\u0041"', '"\\/"', '"\\n"', // unneeded escapes
    '1.0', '1e2', '-0', '01', '0x10', '9007199254740992', // numbers
    'NaN', 'undefined', "'x'", '{a:1}', '[1,]', // not JSON
    '"é"', // non-ASCII
  ];
  for (const s of bad) assert.throws(() => parseCanon(s), CodecError, s);
});

test('randomBytes', () => {
  assert.equal(randomBytes(0).length, 0);
  assert.equal(randomBytes(100000).length, 100000);
  assert.notDeepEqual(randomBytes(32), randomBytes(32));
  assert.throws(() => randomBytes(-1), CodecError);
});
