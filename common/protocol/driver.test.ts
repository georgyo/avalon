/**
 * Lobby/game interaction scenarios of §12 (docs/p2p-protocol.md §4.6): admin
 * config equivocation (no honest seat blamed; stale seats superseded), a join
 * request between config and keys (start not stalled), a takeover roster
 * during a running game (game stays current).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b64uEncode } from '../crypto/bytes.ts';
import type { Hex32 } from '../crypto/types.ts';
import { isSuperseded, selectCurrentGame } from './driver.ts';
import type { Signer } from './envelope.ts';
import { checkConfig, conflictingConfigs, reduceLobby } from './lobby.ts';
import { makeMsg, testSigner } from './lobbyTestkit.ts';
import { RULES_HASH } from './rules.ts';
import type { GameConfig, Member, StoredMsg } from './types.ts';
import { evalFull } from '../testing/transcript.ts';

const S = Array.from({ length: 6 }, (_, i) => testSigner(500 + i));
const NAMES = ['ALICE', 'BOB', 'CAROL', 'DAVE', 'ERIN', 'FRANK'];
let clock = 1;

function lobby(): { create: StoredMsg; roster1: StoredMsg; members: Member[]; lobbyId: Hex32 } {
  const create = makeMsg(S[0], 'lobby.create', { t: clock++ }, { code: 'ABCD', name: NAMES[0], nonce: b64uEncode(new Uint8Array(16)) });
  const lobbyId = create.msgId;
  const members: Member[] = S.slice(0, 5).map((s, i) => ({ pub: s.pub, name: NAMES[i], joinId: i === 0 ? lobbyId : create.msgId }));
  const roster1 = makeMsg(S[0], 'lobby.roster', { lobby: lobbyId, prev: lobbyId, t: clock++ },
    { seq: 1, admin: S[0].pub, members, rejected: [], closed: false });
  return { create, roster1, members, lobbyId };
}

function config(by: Signer, lobbyId: Hex32, prev: Hex32, gameId: string, roles: string[]): StoredMsg {
  const body: GameConfig = {
    gameId, seats: S.slice(0, 5).map((s, i) => ({ pub: s.pub, name: NAMES[i] })), selectedRoles: roles,
    options: { inGameLog: false }, rulesHash: RULES_HASH,
  };
  return makeMsg(by, 'lobby.config', { lobby: lobbyId, prev, t: clock++ }, body);
}

const GAME = b64uEncode(new Uint8Array(16).fill(9));

test('a join request between config and keys does not stall the start', () => {
  const L = lobby();
  const cfg = config(S[0], L.lobbyId, L.roster1.msgId, GAME, ['MERLIN']);
  const j = makeMsg(S[5], 'lobby.join', { lobby: L.lobbyId, t: clock++ }, { name: NAMES[5] });
  const reject = makeMsg(S[0], 'lobby.roster', { lobby: L.lobbyId, prev: L.roster1.msgId, t: clock++ },
    { seq: 2, admin: S[0].pub, members: L.members, rejected: [{ joinId: j.msgId, reason: 'game-active' }], closed: false });
  const st = reduceLobby(L.lobbyId, [L.create, L.roster1, cfg, j, reject]);
  assert.equal(st.head.seq, 2);
  assert.equal(st.currentConfig?.configId, cfg.msgId);
  for (let i = 0; i < 5; i++) assert.deepEqual(checkConfig(st, S[i].pub, { activeGameIds: [] }), { ok: true, seat: i });
  assert.equal(st.joins.get(j.msgId)?.status, 'rejected');
});

test('admin config equivocation: seats refuse to key, the game is INVALID(admin), nobody else is blamed; stale seats are superseded', () => {
  const L = lobby();
  const c1 = config(S[0], L.lobbyId, L.roster1.msgId, GAME, ['MERLIN']);
  const c2 = config(S[0], L.lobbyId, L.roster1.msgId, GAME, ['PERCIVAL']);
  const msgs = [L.create, L.roster1, c1, c2];
  const st = reduceLobby(L.lobbyId, msgs);
  for (let i = 0; i < 5; i++) {
    const r = checkConfig(st, S[i].pub, { activeGameIds: [] });
    assert.equal(r.ok, false);
  }
  const current = st.currentConfig?.configId as Hex32;
  const other = current === c1.msgId ? c2 : c1;
  const conf = conflictingConfigs(current, msgs);
  assert.deepEqual(conf.map((m) => m.msgId), [other.msgId]);
  const cfg = (current === c1.msgId ? c1 : c2).env.body as GameConfig;
  const ev = evalFull(cfg, current, new Map(), { conflictingConfigs: conf, configAuthor: S[0].pub });
  assert.equal(ev.terminal?.kind, 'invalid');
  assert.deepEqual(ev.terminal?.faults.map((f) => [f.seat, f.reason]), [[0, 'config equivocation']]);
  // A seat that had accepted the non-current config (key incomplete) marks it superseded; the current one is not.
  assert.equal(isSuperseded(selectCurrentGame(st, []), other.msgId, false), true);
  assert.equal(isSuperseded(selectCurrentGame(st, []), current, false), false);
});

test('a takeover roster during a running game: the started game stays the current game', () => {
  const L = lobby();
  const cfg = config(S[0], L.lobbyId, L.roster1.msgId, GAME, ['MERLIN']);
  const takeover = makeMsg(S[1], 'lobby.roster', { lobby: L.lobbyId, prev: L.roster1.msgId, t: clock++ },
    { seq: 2, admin: S[1].pub, members: L.members, rejected: [], closed: false });
  const cfg2 = config(S[1], L.lobbyId, takeover.msgId, b64uEncode(new Uint8Array(16).fill(3)), []);
  const st = reduceLobby(L.lobbyId, [L.create, L.roster1, cfg, takeover, cfg2]);
  assert.equal(st.head.admin, S[1].pub);
  assert.equal(st.currentConfig?.configId, cfg2.msgId);
  const games = [{ configId: cfg.msgId, keyComplete: true, terminal: false }, { configId: cfg2.msgId, keyComplete: false, terminal: false }];
  const current = selectCurrentGame(st, games);
  assert.equal(current, cfg.msgId);
  assert.equal(isSuperseded(current, cfg.msgId, true), false);
  // Once the running game is over, the lobby's own current config applies again.
  assert.equal(selectCurrentGame(st, [{ ...games[0], terminal: true }, games[1]]), cfg2.msgId);
});
