import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ristretto255_hasher } from '@noble/curves/ed25519.js';
import { CodecError, b64uEncode, hexDecode, hexEncode, sha512, utf8 } from './bytes.ts';
import {
  CryptoError, G, GEN, H2C, H2S, L, O, decPoint, decScalar, encPoint, encScalar, mod, msm, mul, mulPub, ptBytes,
  randomWeight128, randomWeight128From, smallLog, type Point, type Scalar,
} from './group.ts';
import { seededRandom } from './testkit.ts';

// RFC 9496 Appendix A.1: encodings of 0·B .. 15·B.
const MULTIPLES = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  'e2f2ae0a6abc4e71a884a961c500515f58e30b6aa582dd8db6a65945e08d2d76',
  '6a493210f7499cd17fecb510ae0cea23a110e8d5b901f8acadd3095c73a3b919',
  '94741f5d5d52755ece4f23f044ee27d5d1ea1e2bd196b462166b16152a9d0259',
  'da80862773358b466ffadfe0b3293ab3d9fd53c5ea6c955358f568322daf6a57',
  'e882b131016b52c1d3337080187cf768423efccbb517bb495ab812c4160ff44e',
  'f64746d3c92b13050ed8d80236a7f0007c3b3f962f5ba793d19a601ebb1df403',
  '44f53520926ec81fbd5a387845beb7df85a96a24ece18738bdcfa6a7822a176d',
  '903293d8f2287ebe10e2374dc1a53e0bc887e592699f02d077d5263cdd55601c',
  '02622ace8f7303a31cafc63f8fc48fdc16e1c8c8d234b2f0d6685282a9076031',
  '20706fd788b2720a1ed2a5dad4952b01f413bcf0e7564de8cdc816689e2db95f',
  'bce83f8ba5dd2fa572864c24ba1810f9522bc6004afe95877ac73241cafdab42',
  'e4549ee16b9aa03099ca208c67adafcafa4c3f3e4e5303de6026e3ca8ff84460',
  'aa52e000df2e16f55fb1032fc33bc42742dad6bd5a8fc0be0167436c5948501f',
  '46376b80f409b29dc2b5f6f0c52591990896e5716f41477cd30085ab7f10301e',
  'e0c418f7c8d9c4cdd7395b93ea124f3ad99021bb681dfc3302a9d99a2e53e64e',
];

// RFC 9496 Appendix A.2: invalid encodings.
const INVALID = [
  // non-canonical field encodings
  '00ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'f3ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  // negative field elements
  '0100000000000000000000000000000000000000000000000000000000000000',
  '01ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'ed57ffd8c914fb201471d1c3d245ce3c746fcbe63a3679d51b6a516ebebe0e20',
  'c34c4e1826e5d403b78e246e88aa051c36ccf0aafebffe137d148a2bf9104562',
  'c940e5a4404157cfb1628b108db051a8d439e1a421394ec4ebccb9ec92a8ac78',
  '47cfc5497c53dc8e61c91d17fd626ffb1c49e2bca94eed052281b510b1117a24',
  'f1c6165d33367351b0da8f6e4511010c68174a03b6581212c71c0e1d026c3c72',
  '87260f7a2f12495118360f02c26a470f450dadf34a413d21042b43b9d93e1309',
  // non-square x^2
  '26948d35ca62e643e26a83177332e6b6afeb9d08e4268b650f1f5bbd8d81d371',
  '4eac077a713c57b4f4397629a4145982c661f48044dd3f96427d40b147d9742f',
  'de6a7b00deadc788eb6b6c8d20c0ae96c2f2019078fa604fee5b87d6e989ad7b',
  'bcab477be20861e01e4a0e295284146a510150d9817763caf1a6f4b422d67042',
  '2a292df7e32cababbd9de088d1d1abec9fc0440f637ed2fba145094dc14bea08',
  'f4a9e534fc0d216c44b218fa0c42d99635a0127ee2e53c712f70609649fdff22',
  '8268436f8c4126196cf64b3c7ddbda90746a378625f9813dd9b8457077256731',
  '2810e5cbc2cc4d4eece54f61c6f69758e289aa7ab440b3cbeaa21995c2f4232b',
  // negative xy value
  '3eb858e78f5a7254d8c9731174a94f76755fd3941c0ac93735c07ba14579630e',
  'a45fdc55c76448c049a1ab33f17023edfb2be3581e9c7aade8a6125215e04220',
  'd483fe813c6ba647ebbfd3ec41adca1c6130c2beeee9d9bf065c8d151c5f396e',
  '8a2e1d30050198c65a54483123960ccc38aef6848e1ec8f5f780e8523769ba32',
  '32888462f8b486c68ad7dd9610be5192bbeaf3b443951ac1a8118419d9fa097b',
  '227142501b9d4355ccba290404bde41575b037693cef1f438c47f8fbf35d1165',
  '5c37cc491da847cfeb9281d407efc41e15144c876e0170b499a96a22ed31e01e',
  '445425117cb8c90edcbc7c1cc0e74f747f2c1efa5630a967c64f287792a48a4b',
  // s = -1, which causes y = 0
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
];

// RFC 9496 Appendix A.3: element derivation from SHA-512 of the given strings.
const DERIVED: [string, string][] = [
  ['Ristretto is traditionally a short shot of espresso coffee', '3066f82a1a747d45120d1740f14358531a8f04bbffe6a819f86dfe50f44a0a46'],
  ['made with the normal amount of ground coffee but extracted with', 'f26e5b6f7d362d2d2a94c5d0e7602cb4773c95a2e5c31a64f133189fa76ed61b'],
  ['about half the amount of water in the same amount of time', '006ccd2a9e6867e6a2c5cea83d3302cc9de128dd2a9a57dd8ee7b9d7ffe02826'],
  ['by using a finer grind.', 'f8f0c87cf237953c5890aec3998169005dae3eca1fbb04548c635953c817f92a'],
  ['This produces a concentrated shot of coffee per volume.', 'ae81e7dedf20a497e10c304a765c1767a42d6e06029758d2d7e8ef7cc4c41179'],
  ['Just pulling a normal shot short will produce a weaker shot', 'e2705652ff9f5e44d3e841bf1c251cf7dddb77d140870d1ab2ed64f1a9ce8628'],
  ['and is not a Ristretto as some believe.', '80bd07262511cdde4863f8a7434cef696750681cb9510eea557088f76d9e5065'],
];

const enc32 = (hex: string): string => b64uEncode(hexDecode(hex));

test('L is the ristretto255 group order', () => {
  assert.equal(L, 2n ** 252n + 27742317777372353535851937790883648493n);
  assert.ok(mulPub(G, L - 1n).add(G).is0());
});

test('RFC 9496 A.1: multiples of the generator encode and decode', () => {
  let P = O;
  for (let i = 0; i < MULTIPLES.length; i++) {
    assert.equal(hexEncode(ptBytes(P)), MULTIPLES[i], `${i}·B`);
    assert.equal(encPoint(P), enc32(MULTIPLES[i]));
    if (i > 0) {
      const D = decPoint(enc32(MULTIPLES[i]));
      assert.ok(D.equals(P));
      assert.ok(mulPub(G, BigInt(i)).equals(D));
      assert.ok(mul(G, BigInt(i)).equals(D));
    }
    P = P.add(G);
  }
});

test('RFC 9496 A.2: invalid encodings are rejected', () => {
  for (const h of INVALID) {
    assert.throws(() => decPoint(enc32(h)), CodecError, h);
    assert.throws(() => decPoint(enc32(h), { allowIdentity: true }), CodecError, h);
  }
});

test('RFC 9496 A.3: element derivation', () => {
  for (const [msg, out] of DERIVED) {
    const deriveToCurve = ristretto255_hasher.deriveToCurve;
    assert.ok(deriveToCurve !== undefined);
    assert.equal(hexEncode(ptBytes(deriveToCurve(sha512(utf8(msg))))), out);
  }
});

test('decPoint: identity rejected by default, strict length and base64url', () => {
  const zero = enc32(MULTIPLES[0]);
  assert.throws(() => decPoint(zero), CodecError);
  assert.ok(decPoint(zero, { allowIdentity: true }).is0());
  const g = encPoint(G);
  assert.throws(() => decPoint(g + '='), CodecError);
  assert.throws(() => decPoint(g.slice(0, 42)), CodecError);
  assert.throws(() => decPoint(g + 'AAAA'), CodecError);
  assert.throws(() => decPoint(b64uEncode(new Uint8Array(31))), CodecError);
  // last char with non-zero unused bits (43 chars carry 258 bits for 256)
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const v = ALPHA.indexOf(g[42]);
  assert.equal(v & 3, 0);
  assert.throws(() => decPoint(g.slice(0, 42) + ALPHA[v | 1]), CodecError);
});

test('point encodings are 43 chars and round trip', () => {
  const rng = seededRandom(7);
  for (let i = 0; i < 20; i++) {
    const P = mul(G, mod(BigInt('0x' + hexEncode(rng(40)))) || 1n);
    const s = encPoint(P);
    assert.equal(s.length, 43);
    const D = decPoint(s);
    assert.ok(D.equals(P));
    assert.equal(encPoint(D), s);
  }
});

test('scalar codec: 32-byte little-endian, strict < L', () => {
  assert.equal(encScalar(0n), 'A'.repeat(43));
  assert.equal(decScalar(encScalar(0n)), 0n);
  assert.equal(decScalar(encScalar(1n)), 1n);
  assert.equal(hexEncode(hexDecode('0100000000000000000000000000000000000000000000000000000000000000')), '01' + '00'.repeat(31));
  assert.equal(encScalar(1n), b64uEncode(hexDecode('01' + '00'.repeat(31))));
  assert.equal(decScalar(encScalar(L - 1n)), L - 1n);
  const leBytes = (x: bigint): Uint8Array => {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = Number((x >> BigInt(8 * i)) & 0xffn);
    return out;
  };
  assert.throws(() => decScalar(b64uEncode(leBytes(L))), CodecError);
  assert.throws(() => decScalar(b64uEncode(leBytes(L + 1n))), CodecError);
  assert.throws(() => decScalar(b64uEncode(new Uint8Array(32).fill(0xff))), CodecError);
  assert.throws(() => decScalar(b64uEncode(new Uint8Array(31))), CodecError);
  assert.throws(() => decScalar(encScalar(5n) + '='), CodecError);
  assert.throws(() => encScalar(L), CryptoError);
  assert.throws(() => encScalar(-1n), CryptoError);
});

test('mod, mul, mulPub', () => {
  assert.equal(mod(-1n), L - 1n);
  assert.equal(mod(L), 0n);
  assert.equal(mod(2n * L + 3n), 3n);
  assert.throws(() => mul(G, 0n), CryptoError);
  assert.throws(() => mul(G, L), CryptoError);
  assert.throws(() => mul(G, -1n), CryptoError);
  assert.ok(mulPub(G, 0n).is0());
  assert.throws(() => mulPub(G, L), CryptoError);
  const k = 0x1234567890abcdef1234567890abcdef1234567890abcdefn;
  assert.ok(mul(GEN.J, k).equals(mulPub(GEN.J, k)));
  assert.ok(mul(O, k).is0());
});

test('msm equals the naive sum (both algorithms, identity points, zero scalars)', () => {
  const rng = seededRandom(3);
  const rs = (): Scalar => mod(BigInt('0x' + hexEncode(rng(64))));
  assert.ok(msm([], []).is0());
  for (const n of [1, 2, 5, 81, 120]) {
    const pts: Point[] = Array.from({ length: n }, (_, i) => (i === 1 ? O : mul(G, rs() || 1n)));
    const scs: Scalar[] = Array.from({ length: n }, (_, i) => (i === 2 ? 0n : rs()));
    let naive = O;
    for (let i = 0; i < n; i++) naive = naive.add(mulPub(pts[i], scs[i]));
    assert.ok(msm(pts, scs).equals(naive), `n = ${n}`);
  }
  assert.throws(() => msm([G], []), CryptoError);
  assert.throws(() => msm([G], [L]), CryptoError);
});

test('H2C / H2S are deterministic and domain separated', () => {
  const m = utf8('msg');
  assert.ok(H2C('avalon-p2p/v1/a', m).equals(H2C('avalon-p2p/v1/a', m)));
  assert.ok(!H2C('avalon-p2p/v1/a', m).equals(H2C('avalon-p2p/v1/b', m)));
  assert.ok(!H2C('avalon-p2p/v1/a', m).equals(H2C('avalon-p2p/v1/a', utf8('msh'))));
  const s = H2S('avalon-p2p/v1/a', m);
  assert.ok(s >= 0n && s < L);
  assert.equal(s, H2S('avalon-p2p/v1/a', m));
  assert.notEqual(s, H2S('avalon-p2p/v1/b', m));
  // §2.4: H2S = expand_message_xmd(SHA-512, 64 bytes) as a little-endian integer mod L
  assert.equal(s, ristretto255_hasher.hashToScalar(m, { DST: utf8('avalon-p2p/v1/a') }));
});

test('generators: pinned encodings, pairwise distinct, not O or G', () => {
  const pinned: Record<string, string> = {
    S: 'vgDJ7HU0SQqOa5e4PuO8P_sDLRwLKDFGe8wPbjcGOF4',
    J: '5IenY0qF-ew8Wa3OOagyK9YqYnSodQkVL5t4nylg3WI',
    H0: 'mrsFmfMO2A5WgPXqCQ_BzDsEKy3h_sTFyqha0v18Gmc',
  };
  const pinnedH = [
    'vsNvZnXtdn1Ej6t7Phzkr-Dra3G56YJKrU6ItWgDc1k', 'mMIFr1rAAhE2t7rXvSdqd3bPhsl6qzHWzpnHsOaL2xk',
    'KktGNbpGYZbm9Kq9szQrkSOuJNrt7sZ6W6cKLqc4Yk0', 'KCQPhN_sb9-3wx-py5869Yg-WqTP5y90pA9SG9U2B3E',
    'XtX26oyU5NGFds-g4P5uwRAPOWbcVyYEAwdaRMpsIU0', 'aF1KdMfcr3Fk0ZsC_ZczfqLMBKKdc9D5t8iworGcXBM',
    'dNhYNbSjzb2stUiHBTowII_58wiOz7GzfmcAgOUu8wM', 'bk9XGNemAPmb4lE7a5VZ7iea32OUpWiU4CsurNIkc1s',
    '6FBDIrZKK0vGmEW1alCdVTMYYPKwpW-J8jKDwx7qqBo', 'QLiih97JJY1AKkviXb-YOePHnf0x4D9EYgPzANC5_wo',
  ];
  assert.equal(encPoint(GEN.S), pinned.S);
  assert.equal(encPoint(GEN.J), pinned.J);
  assert.equal(encPoint(GEN.H0), pinned.H0);
  assert.equal(GEN.H.length, 10);
  GEN.H.forEach((h, i) => assert.equal(encPoint(h), pinnedH[i]));
  // definitions of §2.4
  assert.ok(GEN.S.equals(H2C('avalon-p2p/v1/gen', utf8('ot-S'))));
  assert.ok(GEN.H[3].equals(H2C('avalon-p2p/v1/gen', utf8('shuffle-H/3'))));
  const all = [G, O, GEN.S, GEN.J, GEN.H0, ...GEN.H].map(encPoint);
  assert.equal(new Set(all).size, all.length);
});

test('smallLog', () => {
  for (let k = 0; k <= 10; k++) assert.equal(smallLog(mulPub(G, BigInt(k)), 10), k);
  assert.equal(smallLog(mulPub(G, 11n), 10), null);
  assert.equal(smallLog(GEN.S, 10), null);
  assert.equal(smallLog(O, 0), 0);
});

test('randomWeight128: nonzero, 128-bit; only the internal variant takes a byte source', () => {
  for (let i = 0; i < 50; i++) {
    const z = randomWeight128();
    assert.ok(z > 0n && z < 2n ** 128n);
  }
  // the production function takes no source (review finding: no deterministic weights in production)
  assert.equal(randomWeight128.length, 0);
  assert.equal(randomWeight128From(seededRandom(5)), randomWeight128From(seededRandom(5)));
  let calls = 0;
  const zeroThenOne = (n: number): Uint8Array => {
    calls++;
    const b = new Uint8Array(n);
    if (calls > 1) b[n - 1] = 1;
    return b;
  };
  assert.equal(randomWeight128From(zeroThenOne), 1n);
  assert.equal(calls, 2);
});
