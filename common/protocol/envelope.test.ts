import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { p256 } from '@noble/curves/nist.js';
import { b64uDecode, b64uEncode, canon, concat, hexDecode, hexEncode, sha256, utf8 } from '../crypto/bytes.ts';
import { encPoint, encScalar, G, GEN, L } from '../crypto/group.ts';
import {
  decodeEnvelope, encodeEnvelope, EnvelopeError, gunKeyOf, isGameStepId, isStepFor, monthOf, msgIdOf, parseEnvelope,
  signerFromPair, soulOf, type Signer,
} from './envelope.ts';
import { testPair, testSigner } from './lobbyTestkit.ts';
import { RULES_HASH } from './rules.ts';
import type { Bodies, Envelope, MsgType } from './types.ts';

// A SEA pair generated once with the user's GUN fork (`await Gun.SEA.pair()`), epub/epriv omitted.
const SEA_PAIR = {
  pub: 'ILrJsxRDFEIGbtuc8KSCsrcXcnHzhsAmvuJkBpA3E54.eKnSSFo3aJe96YiDkgnce3taUtuAqIFPgDqu3nQAUgs',
  priv: '2zU6g8Dp9b7_ArGFYjGRZ2F0GZ3E45zz9vBv-6FCGZI',
};

const CREATE: Envelope<'lobby.create'> = {
  v: 1, type: 'lobby.create', lobby: '', game: '', step: '', author: SEA_PAIR.pub, prev: '', t: 1760000000000,
  body: { code: 'ABCD', name: 'ALICE', nonce: 'AAECAwQFBgcICQoLDA0ODw' },
};

const VECTOR = {
  value: 'AV1.eyJhdXRob3IiOiJJTHJKc3hSREZFSUdidHVjOEtTQ3NyY1hjbkh6aHNBbXZ1SmtCcEEzRTU0LmVLblNTRm8zYUplOTZZaURrZ25jZTN0YVV0dUFxSUZQZ0RxdTNuUUFVZ3MiLCJib2R5Ijp7ImNvZGUiOiJBQkNEIiwibmFtZSI6IkFMSUNFIiwibm9uY2UiOiJBQUVDQXdRRkJnY0lDUW9MREEwT0R3In0sImdhbWUiOiIiLCJsb2JieSI6IiIsInByZXYiOiIiLCJzdGVwIjoiIiwidCI6MTc2MDAwMDAwMDAwMCwidHlwZSI6ImxvYmJ5LmNyZWF0ZSIsInYiOjF9.TvAKZZur9v2nRShwx27WxmAxuWrpLGdsdoT1KhCwT3N0FuzPhU-aTu-fBGKHb6slvH7h2vDpw7-LXNvnSlQs7A',
  key: '30bb213c2403864c279399512937c5f1473a6986f94e5ea9de842c40ac52ec06',
  msgId: '45a4518077f2742aa7571720cbce9ef652c803e518f7fe531ca1e8e8de1c28c4',
  sig: 'TvAKZZur9v2nRShwx27WxmAxuWrpLGdsdoT1KhCwT3N0FuzPhU-aTu-fBGKHb6slvH7h2vDpw7-LXNvnSlQs7A',
};

const ROSTER_VECTOR = {
  key: 'c8ae1b944dc9ef0e337691872cfb870b9a797affbcb17a1149ff7843e6007b40',
  msgId: 'ec2cff16e7240f30a184f1be9ffeded2081d3253b9aa1e784c61f481c0808506',
};

const N_HALF = p256.Point.CURVE().n >> 1n;

function bigBE(b: Uint8Array): bigint {
  return BigInt('0x' + (hexEncode(b) || '0'));
}

function beBytes(x: bigint, len: number): Uint8Array {
  return hexDecode(x.toString(16).padStart(len * 2, '0'));
}

test('vector: fixed SEA pair, lobby.create envelope, msgId, signature and GUN key', () => {
  const signer = signerFromPair(SEA_PAIR);
  const enc = encodeEnvelope(CREATE, signer);
  assert.equal(enc.value, VECTOR.value);
  assert.equal(enc.key, VECTOR.key);
  assert.equal(enc.msgId, VECTOR.msgId);
  assert.equal(enc.value.split('.')[2], VECTOR.sig);
  // Independent recomputation of the §3.3 formulas.
  const mBytes = utf8(canon(CREATE));
  assert.equal(enc.value, 'AV1.' + b64uEncode(mBytes) + '.' + VECTOR.sig);
  assert.equal(hexEncode(sha256(utf8('avalon-p2p/v1/msg\0'), mBytes)), VECTOR.msgId);
  assert.equal(hexEncode(sha256(utf8(enc.value))), VECTOR.key);
  assert.equal(msgIdOf(CREATE), VECTOR.msgId);
  const d = decodeEnvelope(VECTOR.value, VECTOR.key);
  assert.ok(!('error' in d), JSON.stringify(d));
  assert.deepEqual(d.env, CREATE);
  assert.equal(d.msgId, VECTOR.msgId);

  // The roster that follows it.
  const roster: Envelope<'lobby.roster'> = {
    v: 1, type: 'lobby.roster', lobby: VECTOR.msgId, game: '', step: '', author: SEA_PAIR.pub, prev: VECTOR.msgId, t: 1760000000001,
    body: { seq: 1, admin: SEA_PAIR.pub, members: [{ pub: SEA_PAIR.pub, name: 'ALICE', joinId: VECTOR.msgId }], rejected: [], closed: false },
  };
  const r = encodeEnvelope(roster, signer);
  assert.equal(r.key, ROSTER_VECTOR.key);
  assert.equal(r.msgId, ROSTER_VECTOR.msgId);
});

test('the signature verifies with WebCrypto (as SEA would) over tag ‖ msgId, and is low-S', async () => {
  const [x, y] = SEA_PAIR.pub.split('.');
  const key = await webcrypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x, y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const msg = concat(utf8('avalon-p2p/v1/sig\0'), hexDecode(VECTOR.msgId));
  const sig = b64uDecode(VECTOR.sig, 64);
  assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Uint8Array.from(sig), Uint8Array.from(msg)), true);
  assert.ok(bigBE(sig.slice(32)) <= N_HALF, 'low-S');
  // noble's public key from the SEA priv equals the SEA pub
  const pub = p256.getPublicKey(b64uDecode(SEA_PAIR.priv, 32), false);
  assert.equal(b64uEncode(pub.slice(1, 33)) + '.' + b64uEncode(pub.slice(33)), SEA_PAIR.pub);
});

test('signatures are deterministic and always low-S', () => {
  const signer = testSigner(1);
  for (let i = 0; i < 64; i++) {
    const env: Envelope<'lobby.join'> = { v: 1, type: 'lobby.join', lobby: VECTOR.msgId, game: '', step: '', author: signer.pub, prev: '', t: i, body: { name: 'BOB' } };
    const a = encodeEnvelope(env, signer);
    const b = encodeEnvelope(env, signer);
    assert.equal(a.value, b.value);
    assert.ok(bigBE(b64uDecode(a.value.split('.')[2], 64).slice(32)) <= N_HALF);
  }
});

test('rejects a high-S signature, tampered values, wrong keys and foreign signatures', () => {
  const [prefix, m, s] = VECTOR.value.split('.');
  const sig = b64uDecode(s, 64);
  const n = p256.Point.CURVE().n;
  const highS = concat(sig.slice(0, 32), beBytes(n - bigBE(sig.slice(32)), 32));
  // the high-S twin is a valid non-normalized ECDSA signature
  assert.equal(p256.verify(highS, concat(utf8('avalon-p2p/v1/sig\0'), hexDecode(VECTOR.msgId)), concat(Uint8Array.of(4), b64uDecode(SEA_PAIR.pub.slice(0, 43)), b64uDecode(SEA_PAIR.pub.slice(44))), { prehash: true, lowS: false }), true);
  const highValue = [prefix, m, b64uEncode(highS)].join('.');
  assert.deepEqual(decodeEnvelope(highValue), { error: 'bad signature' });

  assert.deepEqual(decodeEnvelope(VECTOR.value, VECTOR.key.replace(/^3/, '4')), { error: 'key is not the hash of the value' });
  assert.ok('error' in decodeEnvelope(VECTOR.value, VECTOR.msgId));
  assert.ok(!('error' in decodeEnvelope(VECTOR.value)), 'key is optional');

  // Tampered message bytes (same signature).
  const tampered = { ...CREATE, t: CREATE.t + 1 };
  const tv = 'AV1.' + b64uEncode(utf8(canon(tampered))) + '.' + s;
  assert.deepEqual(decodeEnvelope(tv), { error: 'bad signature' });
  // Signed by somebody else but claiming the SEA pair's author.
  const other = testSigner(2);
  const forged: Signer = { pub: SEA_PAIR.pub, sign: (msg) => other.sign(msg) };
  assert.deepEqual(decodeEnvelope(encodeEnvelope(CREATE, forged).value), { error: 'bad signature' });
  assert.throws(() => encodeEnvelope(CREATE, other), EnvelopeError);

  // Shape errors.
  for (const bad of [
    'AV2.' + m + '.' + s, 'AV1.' + m, 'AV1.' + m + '.' + s + '.x', 'AV1.' + m + '=.' + s, 'AV1.' + m + '.' + s + 'A',
    'SEA{"m":1}', 'AV1.' + m + '.' + s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A'), 'AV1.' + 'x'.repeat(70000),
  ]) {
    assert.ok('error' in decodeEnvelope(bad), bad.slice(0, 40));
  }
  assert.ok('error' in decodeEnvelope(42 as unknown as string));
});

test('rejects non-canonical JSON even when correctly signed', () => {
  const signer = signerFromPair(SEA_PAIR);
  const sign = (json: string): string => {
    const mBytes = utf8(json);
    const id = sha256(utf8('avalon-p2p/v1/msg\0'), mBytes);
    return 'AV1.' + b64uEncode(mBytes) + '.' + b64uEncode(signer.sign(concat(utf8('avalon-p2p/v1/sig\0'), id)));
  };
  const good = canon(CREATE);
  assert.ok(!('error' in decodeEnvelope(sign(good))));
  const variants = [
    JSON.stringify(CREATE),                                    // unsorted keys
    good.replace('"v":1', '"v":1.0'),
    good.replace('{', '{ '),
    good.replace('"t":1760000000000', '"t":1760000000000,"t":1760000000000'),
    good.replace('"v":1}', '"v":1,"extra":0}'),
    good.replace('"step":"",', ''),
    good.replace('"ALICE"', '"\\u0041LICE"'),
  ];
  for (const v of variants) assert.ok('error' in decodeEnvelope(sign(v)), v.slice(0, 60));
});

// ---------------------------------------------------------------- schema per type

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const PT = encPoint(G);
const PT2 = encPoint(GEN.S);
const SC = encScalar(12345n);
const HEX = 'ab'.repeat(32);
const GAME = b64uEncode(new Uint8Array(16).fill(7));
const PROOF = { K: [[PT, PT2]], e: [SC], s: [[SC]] };
const CT = { a: PT, b: PT2 };
const pubs = [0, 1, 2, 3, 4].map((i) => testPair(i).pub);

const SAMPLES: { [T in MsgType]: { step: string; prev: string; body: Bodies[T] } } = {
  'lobby.create': { step: '', prev: '', body: { code: 'WXYZ', name: 'ALICE', nonce: b64uEncode(new Uint8Array(16)) } },
  'lobby.join': { step: '', prev: '', body: { name: 'BOB' } },
  'lobby.leave': { step: '', prev: HEX, body: {} },
  'lobby.roster': { step: '', prev: HEX, body: { seq: 3, admin: pubs[0], members: [{ pub: pubs[0], name: 'ALICE', joinId: HEX }], rejected: [{ joinId: HEX, reason: 'full' }], closed: false } },
  'lobby.config': { step: '', prev: HEX, body: { gameId: GAME, seats: pubs.map((pub, i) => ({ pub, name: 'P' + 'ABCDE'[i] })), selectedRoles: ['MERLIN', 'ASSASSIN'], options: { inGameLog: true }, rulesHash: RULES_HASH } },
  key: { step: 'key', prev: HEX, body: { y: PT, pok: PROOF, seedCommit: HEX } },
  shuffle: { step: 'shuf/4', prev: HEX, body: { deck: Array(5).fill(CT), c: Array(5).fill(PT), chat: Array(5).fill(PT), proof: PROOF } },
  deal: { step: 'deal', prev: HEX, body: { d: [null, PT, PT, PT, PT], proof: PROOF } },
  'ot.recv': { step: 'otR', prev: HEX, body: { U: PT, proof: PROOF } },
  'ot.send': { step: 'otS', prev: HEX, body: { F: [CT, CT], E: [null, [CT, CT], [CT, CT], [CT, CT], [CT, CT]], profile: PROOF, eq: PROOF, seed: b64uEncode(new Uint8Array(32)) } },
  propose: { step: 'p/2/4', prev: HEX, body: { team: [0, 3, 4] } },
  'vote.commit': { step: 'vc/0/0', prev: HEX, body: { commit: HEX } },
  'vote.reveal': { step: 'vr/4/4', prev: HEX, body: { approve: false, nonce: b64uEncode(new Uint8Array(32)) } },
  ballot: { step: 'mv/1', prev: HEX, body: { ballot: CT, proof: PROOF } },
  tally: { step: 'mt/3', prev: HEX, body: { share: PT, proof: PROOF } },
  assassinate: { step: 'as', prev: HEX, body: { target: 2, open: PT, proof: PROOF } },
  cancel: { step: 'cancel', prev: HEX, body: { at: 'vc/1/2', reason: 'leave' } },
  reveal: { step: 'reveal', prev: HEX, body: { x: SC, ballots: [{ m: 0, r: SC }, { m: 2, r: SC }], basis: [HEX] } },
  log: {
    step: '', prev: HEX, body: {
      gameId: GAME, configId: HEX, lobbyCode: 'WXYZ', createdAt: Date.UTC(2026, 9, 9, 12),
      outcome: {
        state: 'EVIL_WIN', message: 'Merlin assassinated', assassinated: 'PB',
        roles: [{ name: 'PA', role: 'MERLIN', assassin: false }, { name: 'PB', role: 'UNKNOWN' }],
        votes: [{ PA: true, PB: false }, {}], final: false, unrevealed: ['PB'], cheaters: [{ name: 'PC', reason: 'invalid reveal' }],
      },
      missions: [{ state: 'FAIL', team: ['PA', 'PB'], teamSize: 2, failsRequired: 1, numFails: 1, proposals: [{ proposer: 'PA', team: ['PA', 'PB'], votes: ['PA', 'PC', 'PD'], state: 'APPROVED' }] }],
      players: pubs.map((uid, i) => ({ name: 'P' + 'ABCDE'[i], uid })),
      options: { inGameLog: false },
    },
  },
};

function sampleEnv<T extends MsgType>(type: T, author: string): Envelope<T> {
  const s = SAMPLES[type];
  const isLobby = type.startsWith('lobby.');
  return {
    v: 1, type, lobby: type === 'lobby.create' ? '' : HEX, game: isLobby ? '' : GAME, step: s.step, author, prev: s.prev, t: 5, body: s.body,
  } as Envelope<T>;
}

test('every message type round-trips and lands in its soul (§3.1)', () => {
  const signer = testSigner(0);
  const souls: Record<string, string> = {};
  for (const type of Object.keys(SAMPLES) as MsgType[]) {
    const env = sampleEnv(type, signer.pub);
    const enc = encodeEnvelope(env, signer);
    const d = decodeEnvelope(enc.value, enc.key);
    assert.ok(!('error' in d), `${type}: ${'error' in d ? d.error : ''}`);
    assert.deepEqual(d.env, env, type);
    assert.equal(enc.key, gunKeyOf(enc.value));
    souls[type] = soulOf(d.env, 'WXYZ');
  }
  assert.equal(souls['lobby.create'], 'avalon/v1/lobby/WXYZ#');
  assert.equal(souls['lobby.config'], 'avalon/v1/lobby/WXYZ#');
  for (const t of ['key', 'shuffle', 'deal', 'ot.recv', 'ot.send']) assert.equal(souls[t], `avalon/v1/game/${GAME}/setup#`);
  for (const t of ['propose', 'vote.commit', 'vote.reveal', 'ballot', 'tally', 'assassinate', 'cancel', 'reveal']) {
    assert.equal(souls[t], `avalon/v1/game/${GAME}/play#`);
  }
  assert.equal(souls.log, 'avalon/v1/logs/2026-10#');
  assert.throws(() => soulOf(sampleEnv('lobby.join', signer.pub), 'abcd'));
  assert.throws(() => soulOf(sampleEnv('lobby.join', signer.pub), 'ABCI'), 'I is not in the alphabet');
});

/** Mutates a sample and expects parseEnvelope to reject it. */
function rejects(type: MsgType, mutate: (e: Record<string, unknown> & { body: Record<string, unknown> }) => void, label: string): void {
  const env = JSON.parse(JSON.stringify(sampleEnv(type, pubs[0]))) as Record<string, unknown> & { body: Record<string, unknown> };
  mutate(env);
  assert.throws(() => parseEnvelope(env), EnvelopeError, `${type}: ${label}`);
}

test('strict schema: exact keys, encodings, ranges, step ids, prev rules', () => {
  for (const type of Object.keys(SAMPLES) as MsgType[]) {
    assert.doesNotThrow(() => parseEnvelope(JSON.parse(JSON.stringify(sampleEnv(type, pubs[0])))), type);
    rejects(type, (e) => { e.extra = 1; }, 'unknown envelope key');
    rejects(type, (e) => { delete e.t; }, 'missing t');
    rejects(type, (e) => { e.v = 2; }, 'version');
    rejects(type, (e) => { e.t = -1; }, 'negative t');
    rejects(type, (e) => { e.author = pubs[0].replace(/^./, (c) => (c === 'A' ? 'B' : 'A')); }, 'author not a point (or different)');
    rejects(type, (e) => { e.author = 'x.y'; }, 'malformed author');
    rejects(type, (e) => { e.body.extra = 1; }, 'unknown body key');
    rejects(type, (e) => { e.step = 'bogus'; }, 'step');
    rejects(type, (e) => { e.lobby = type === 'lobby.create' ? HEX : ''; }, 'lobby');
    rejects(type, (e) => { e.game = type.startsWith('lobby.') ? GAME : ''; }, 'game');
    rejects(type, (e) => { e.prev = type === 'lobby.create' || type === 'lobby.join' ? HEX : ''; }, 'prev');
    rejects(type, (e) => { e.type = 'lobby.kick'; }, 'type');
  }
  rejects('lobby.create', (e) => { e.body.code = 'ABCI'; }, 'code alphabet');
  rejects('lobby.create', (e) => { e.body.name = 'MERLIN'; }, 'role name');
  rejects('lobby.create', (e) => { e.body.nonce = b64uEncode(new Uint8Array(15)); }, 'nonce length');
  rejects('lobby.join', (e) => { e.body.name = 'bob'; }, 'lowercase name');
  rejects('lobby.roster', (e) => { e.body.seq = 0; }, 'seq 0');
  rejects('lobby.roster', (e) => { e.body.rejected = [{ joinId: HEX, reason: 'banned' }]; }, 'reason');
  rejects('lobby.roster', (e) => { e.body.members = Array(11).fill({ pub: pubs[0], name: 'ALICE', joinId: HEX }); }, '11 members');
  rejects('lobby.config', (e) => { e.body.selectedRoles = ['ASSASSIN', 'MERLIN']; }, 'roles order');
  rejects('lobby.config', (e) => { e.body.seats = (e.body.seats as unknown[]).slice(0, 4); }, '4 seats');
  rejects('lobby.config', (e) => { e.body.gameId = GAME.slice(0, 21); }, 'gameId length');
  rejects('lobby.config', (e) => { e.body.gameId = 'A'.repeat(21) + 'B'; }, 'gameId non-canonical trailing bits');
  rejects('key', (e) => { e.body.y = PT + 'A'; }, 'point length');
  rejects('key', (e) => { e.body.y = PT.slice(0, -1) + B64_CHARS[(B64_CHARS.indexOf(PT[42]) & ~3) | 1]; }, 'non-canonical point base64');
  rejects('key', (e) => { e.body.pok = { K: [[PT]], e: [SC, SC], s: [[SC]] }; }, 'proof shape');
  rejects('key', (e) => { e.body.pok = { K: [[PT]], e: [encScalarRaw(L)], s: [[SC]] }; }, 'scalar >= L');
  rejects('shuffle', (e) => { e.step = 'shuf/10'; }, 'shuffle index');
  rejects('shuffle', (e) => { e.step = 'shuf/01'; }, 'leading zero');
  rejects('propose', (e) => { e.body.team = [3, 1]; }, 'not ascending');
  rejects('propose', (e) => { e.body.team = [1, 1]; }, 'duplicate');
  rejects('propose', (e) => { e.body.team = [0, 10]; }, 'seat range');
  rejects('propose', (e) => { e.step = 'p/5/0'; }, 'mission range');
  rejects('propose', (e) => { e.step = 'vc/0/0'; }, 'step of another type');
  rejects('vote.reveal', (e) => { e.body.approve = 1; }, 'approve not boolean');
  rejects('assassinate', (e) => { e.body.target = 1.5; }, 'non-integer');
  rejects('cancel', (e) => { e.body.at = 'cancel'; }, 'cancel at cancel');
  rejects('cancel', (e) => { e.body.reason = 'bored'; }, 'reason');
  rejects('reveal', (e) => { e.body.ballots = [{ m: 2, r: SC }, { m: 1, r: SC }]; }, 'ballots order');
  rejects('log', (e) => { e.body.gameId = b64uEncode(new Uint8Array(16).fill(8)); }, 'log gameId mismatch');
  rejects('log', (e) => { (e.body.outcome as Record<string, unknown>).state = 'DRAW'; }, 'outcome state');
  rejects('log', (e) => { (e.body.outcome as Record<string, unknown>).extra = 1; }, 'outcome key');
  rejects('ot.send', (e) => { e.body.seed = b64uEncode(new Uint8Array(31)); }, 'seed length');
  rejects('deal', (e) => { e.body.d = [null, PT, PT, PT]; }, 'too few shares');
});

function encScalarRaw(x: bigint): string {
  const out = new Uint8Array(32);
  let v = x;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b64uEncode(out);
}

test('encodeEnvelope refuses envelopes peers would reject', () => {
  const signer = testSigner(0);
  const env = sampleEnv('propose', signer.pub);
  assert.throws(() => encodeEnvelope({ ...env, body: { team: [2, 1] } }, signer), EnvelopeError);
  const big = sampleEnv('reveal', signer.pub);
  assert.throws(() => encodeEnvelope({ ...big, body: { ...big.body, basis: Array(257).fill(HEX) } } as Envelope, signer), EnvelopeError, 'list cap');
  const wide = { K: Array(16).fill(Array(100).fill(PT)), e: Array(16).fill(SC), s: Array(16).fill([SC]) };
  assert.throws(() => encodeEnvelope({ ...sampleEnv('tally', signer.pub), body: { share: PT, proof: wide } } as Envelope, signer),
    /value too long/, 'value > 64 KiB');
});

test('step id grammar', () => {
  assert.ok(isStepFor('key', 'key'));
  assert.ok(isStepFor('shuffle', 'shuf/9'));
  assert.ok(!isStepFor('shuffle', 'shuf/-1'));
  assert.ok(isStepFor('vote.commit', 'vc/4/4'));
  assert.ok(!isStepFor('vote.commit', 'vc/4/5'));
  assert.ok(isStepFor('tally', 'mt/0'));
  assert.ok(!isStepFor('tally', 'mt/5'));
  assert.ok(isStepFor('lobby.roster', ''));
  assert.ok(isStepFor('log', ''));
  assert.ok(isGameStepId('as') && isGameStepId('otS') && isGameStepId('mv/2'));
  assert.ok(!isGameStepId('reveal') && !isGameStepId('cancel') && !isGameStepId(''));
});

test('monthOf matches Date in UTC', () => {
  let x = 12345;
  for (let i = 0; i < 2000; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const ms = Math.floor((x / 2147483648) * 4102444800000);   // 1970..2100
    const d = new Date(ms);
    const expected = String(d.getUTCFullYear()).padStart(4, '0') + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
    assert.equal(monthOf(ms), expected, String(ms));
  }
  for (const ms of [0, Date.UTC(2000, 1, 29, 23, 59, 59, 999), Date.UTC(2000, 2, 1), Date.UTC(2026, 11, 31, 23, 59, 59, 999), Date.UTC(2027, 0, 1)]) {
    const d = new Date(ms);
    assert.equal(monthOf(ms), `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  assert.throws(() => monthOf(-1));
  assert.throws(() => monthOf(1.5));
});

test('signerFromPair rejects a mismatched pair', () => {
  assert.throws(() => signerFromPair({ pub: testPair(1).pub, priv: testPair(2).priv }), EnvelopeError);
  assert.throws(() => signerFromPair({ pub: 'x.y', priv: testPair(2).priv }));
});
