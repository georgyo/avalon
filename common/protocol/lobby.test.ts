import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b64uEncode } from '../crypto/bytes.ts';
import type { Hex32 } from '../crypto/types.ts';
import type { Signer } from './envelope.ts';
import {
  adminNextAction, candidates, checkConfig, conflictingConfigs, reduceLobby, rejectionMessage, type LobbyState,
} from './lobby.ts';
import { makeMsg, testSigner } from './lobbyTestkit.ts';
import { RULES_HASH } from './rules.ts';
import type { Bodies, GameConfig, Member, StoredMsg } from './types.ts';

const S = Array.from({ length: 14 }, (_, i) => testSigner(100 + i));
const [A, B, C, D, E, F] = S;
const NAMES = ['ALICE', 'BOB', 'CAROL', 'DAVE', 'ERIN', 'FRANK', 'GRACE', 'HEIDI', 'IVAN', 'JUDY', 'KEN', 'LEO', 'MIA', 'NED'];
const nameOf = (s: Signer): string => NAMES[S.indexOf(s)];

let clock = 1000;
let nonceCtr = 0;

function create(s: Signer, code = 'ABCD'): StoredMsg {
  const nonce = new Uint8Array(16);
  nonce[0] = nonceCtr++;
  return makeMsg(s, 'lobby.create', { t: clock++ }, { code, name: nameOf(s), nonce: b64uEncode(nonce) });
}

function roster(s: Signer, lobbyId: Hex32, prev: Hex32, body: Partial<Bodies['lobby.roster']> & { seq: number; members: Member[] }): StoredMsg {
  return makeMsg(s, 'lobby.roster', { lobby: lobbyId, prev, t: clock++ }, {
    admin: body.admin ?? s.pub, rejected: body.rejected ?? [], closed: body.closed ?? false, seq: body.seq, members: body.members,
  });
}

function join(s: Signer, lobbyId: Hex32, name = nameOf(s)): StoredMsg {
  return makeMsg(s, 'lobby.join', { lobby: lobbyId, t: clock++ }, { name });
}

function leave(s: Signer, lobbyId: Hex32, joinId: Hex32): StoredMsg {
  return makeMsg(s, 'lobby.leave', { lobby: lobbyId, prev: joinId, t: clock++ }, {});
}

function config(s: Signer, lobbyId: Hex32, prev: Hex32, members: Member[], over: Partial<GameConfig> = {}): StoredMsg {
  const gid = new Uint8Array(16);
  gid[0] = nonceCtr++;
  return makeMsg(s, 'lobby.config', { lobby: lobbyId, prev, t: clock++ }, {
    gameId: b64uEncode(gid), seats: members.map((m) => ({ pub: m.pub, name: m.name })), selectedRoles: ['MERLIN', 'ASSASSIN'],
    options: { inGameLog: false }, rulesHash: RULES_HASH, ...over,
  });
}

const member = (s: Signer, joinId: Hex32): Member => ({ pub: s.pub, name: nameOf(s), joinId });

/** A lobby created by A with members A + others admitted in one roster. */
function lobbyWith(others: Signer[]): { msgs: StoredMsg[]; lobbyId: Hex32; members: Member[]; head: Hex32 } {
  const c = create(A);
  const lobbyId = c.msgId;
  const r1 = roster(A, lobbyId, lobbyId, { seq: 1, members: [member(A, lobbyId)] });
  const joins = others.map((o) => join(o, lobbyId));
  const members = [member(A, lobbyId), ...others.map((o, i) => member(o, joins[i].msgId))];
  const r2 = roster(A, lobbyId, r1.msgId, { seq: 2, members });
  return { msgs: [c, r1, ...joins, r2], lobbyId, members, head: r2.msgId };
}

function summary(s: LobbyState): string {
  return JSON.stringify({
    head: s.head, joins: [...s.joins.entries()].sort(), leaves: [...s.leaves].sort(), cur: s.currentConfig?.configId ?? null,
    chain: s.chain.map((n) => n.rosterId),
  });
}

function shuffled<T>(arr: readonly T[], seed: number): T[] {
  const a = arr.slice();
  let x = seed;
  for (let i = a.length - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const j = x % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

test('create + roster 1: head, root admin, fingerprint candidate', () => {
  const c = create(A);
  const s0 = reduceLobby(c.msgId, [c]);
  assert.equal(s0.head.seq, 0);
  assert.equal(s0.head.admin, A.pub);
  assert.deepEqual(s0.head.members, [member(A, c.msgId)]);
  assert.equal(s0.code, 'ABCD');
  const r1 = roster(A, c.msgId, c.msgId, { seq: 1, members: [member(A, c.msgId)] });
  const s1 = reduceLobby(c.msgId, [r1, c]);
  assert.equal(s1.head.rosterId, r1.msgId);
  assert.equal(s1.head.seq, 1);
  assert.throws(() => reduceLobby(c.msgId, [r1]), /not found/);
  const cands = candidates('ABCD', [c, r1]);
  assert.deepEqual(cands, [{ lobbyId: c.msgId, code: 'ABCD', adminPub: A.pub, adminName: 'ALICE', members: ['ALICE'], fingerprint: c.msgId.slice(0, 4).toUpperCase() }]);
  assert.deepEqual(candidates('WXYZ', [c, r1]), []);
});

test('fork choice: incumbent lowest msgId; incumbent beats takeover; takeover by lowest member index', () => {
  const { msgs, lobbyId, members, head } = lobbyWith([B, C, D]);
  // Two incumbent children: lowest msgId wins.
  const i1 = roster(A, lobbyId, head, { seq: 3, members: members.slice(0, 3) });
  const i2 = roster(A, lobbyId, head, { seq: 3, members: members.slice(0, 2) });
  const lowest = i1.msgId < i2.msgId ? i1 : i2;
  assert.equal(reduceLobby(lobbyId, [...msgs, i1, i2]).head.rosterId, lowest.msgId);
  // Takeovers: C (index 2) and B (index 1): B wins; the incumbent beats both.
  const tC = roster(C, lobbyId, head, { seq: 3, members, admin: C.pub });
  const tB = roster(B, lobbyId, head, { seq: 3, members, admin: B.pub });
  assert.equal(reduceLobby(lobbyId, [...msgs, tC, tB]).head.admin, B.pub);
  assert.equal(reduceLobby(lobbyId, [...msgs, tC, tB, i1]).head.rosterId, i1.msgId);
  // Ignored: non-member author, takeover naming someone else as admin, wrong seq, wrong lobby, invalid bodies.
  const outsider = roster(E, lobbyId, head, { seq: 3, members, admin: E.pub });
  const proxy = roster(C, lobbyId, head, { seq: 3, members, admin: D.pub });
  const wrongSeq = roster(A, lobbyId, head, { seq: 4, members });
  const dupNames = roster(A, lobbyId, head, { seq: 3, members: [members[0], { ...members[1], name: 'ALICE' }] });
  const adminNotMember = roster(A, lobbyId, head, { seq: 3, members: members.slice(1), admin: A.pub });
  const s = reduceLobby(lobbyId, [...msgs, outsider, proxy, wrongSeq, dupNames, adminNotMember]);
  assert.equal(s.head.rosterId, head);
  // Order independence over permutations.
  const all = [...msgs, i1, i2, tC, tB, outsider, proxy, wrongSeq, dupNames];
  const ref = summary(reduceLobby(lobbyId, all));
  for (let k = 0; k < 20; k++) assert.equal(summary(reduceLobby(lobbyId, shuffled(all, k + 1))), ref);
  assert.equal(summary(reduceLobby(lobbyId, [...all, ...all])), ref, 'duplicates');
});

test('handoff, kick and closing', () => {
  const { msgs, lobbyId, members, head } = lobbyWith([B, C]);
  // Admin hands off to B (and leaves the member list).
  const h = roster(A, lobbyId, head, { seq: 3, members: members.slice(1), admin: B.pub });
  let s = reduceLobby(lobbyId, [...msgs, h]);
  assert.equal(s.head.admin, B.pub);
  // A is no longer the incumbent at h: A's roster is ignored; B's is used.
  const aAgain = roster(A, lobbyId, h.msgId, { seq: 4, members: members.slice(1), admin: A.pub });
  const kick = roster(B, lobbyId, h.msgId, { seq: 4, members: [members[1]] });
  s = reduceLobby(lobbyId, [...msgs, h, aAgain]);
  assert.equal(s.head.rosterId, h.msgId);
  s = reduceLobby(lobbyId, [...msgs, h, aAgain, kick]);
  assert.deepEqual(s.head.members.map((m) => m.name), ['BOB']);
  // B alone closes the lobby; nothing after a closed roster counts; closed lobbies are not candidates.
  const close = roster(B, lobbyId, kick.msgId, { seq: 5, members: [], closed: true });
  const after = roster(B, lobbyId, close.msgId, { seq: 6, members: [members[1]] });
  s = reduceLobby(lobbyId, [...msgs, h, kick, close, after]);
  assert.equal(s.head.closed, true);
  assert.equal(s.head.rosterId, close.msgId);
  assert.deepEqual(candidates('ABCD', [...msgs, h, kick, close]), []);
  assert.deepEqual(adminNextAction(s, B.pub, false), { kind: 'none' });
});

test('join requests: admitted, rejected with reason, latest decision, withdrawn', () => {
  const c = create(A);
  const lobbyId = c.msgId;
  const r1 = roster(A, lobbyId, lobbyId, { seq: 1, members: [member(A, lobbyId)] });
  const jB = join(B, lobbyId);
  const jC = join(C, lobbyId, 'ALICE');
  const jD = join(D, lobbyId);
  let s = reduceLobby(lobbyId, [c, r1, jB, jC, jD]);
  assert.deepEqual([...s.joins.values()].map((j) => j.status), ['pending', 'pending', 'pending']);
  const r2 = roster(A, lobbyId, r1.msgId, { seq: 2, members: [member(A, lobbyId), member(B, jB.msgId)], rejected: [{ joinId: jC.msgId, reason: 'name-taken' }] });
  s = reduceLobby(lobbyId, [c, r1, jB, jC, jD, r2]);
  assert.equal(s.joins.get(jB.msgId)?.status, 'admitted');
  assert.deepEqual(s.joins.get(jC.msgId), { pub: C.pub, name: 'ALICE', status: 'rejected', reason: 'name-taken' });
  assert.equal(s.joins.get(jD.msgId)?.status, 'pending');
  assert.equal(rejectionMessage('name-taken'), 'Name taken');
  // D withdraws its request with a leave naming the join.
  const wD = leave(D, lobbyId, jD.msgId);
  s = reduceLobby(lobbyId, [c, r1, jB, jC, jD, r2, wD]);
  assert.equal(s.joins.get(jD.msgId)?.status, 'rejected');
  assert.equal(s.joins.get(jD.msgId)?.reason, 'withdrawn');
  assert.deepEqual(adminNextAction(s, A.pub, false), { kind: 'none' }, 'withdrawn and decided joins need no roster');
  // A member entry with a joinId whose join was authored by somebody else does not admit that join.
  const jE = join(E, lobbyId);
  const r3 = roster(A, lobbyId, r2.msgId, { seq: 3, members: [member(A, lobbyId), member(B, jB.msgId), { pub: F.pub, name: 'FRANK', joinId: jE.msgId }] });
  s = reduceLobby(lobbyId, [c, r1, jB, jC, jD, r2, jE, r3]);
  assert.equal(s.joins.get(jE.msgId)?.status, 'pending');
});

test('adminNextAction: admits in ingestion order, name-taken, full, invalid inputs, one roster per batch', () => {
  const c = create(A);
  const lobbyId = c.msgId;
  const r1 = roster(A, lobbyId, lobbyId, { seq: 1, members: [member(A, lobbyId)] });
  const joins = S.slice(1, 12).map((s) => join(s, lobbyId));          // 11 joiners
  const dupName = join(S[12], lobbyId, 'BOB');
  const s = reduceLobby(lobbyId, [c, r1, ...joins, dupName]);
  const a = adminNextAction(s, A.pub, false);
  assert.equal(a.kind, 'roster');
  if (a.kind !== 'roster') return;
  assert.equal(a.prev, undefined);
  assert.equal(a.body.seq, 2);
  assert.equal(a.body.admin, A.pub);
  assert.deepEqual(a.body.members.map((m) => m.name), NAMES.slice(0, 10));
  assert.deepEqual(a.body.rejected, [{ joinId: joins[9].msgId, reason: 'full' }, { joinId: joins[10].msgId, reason: 'full' }, { joinId: dupName.msgId, reason: 'name-taken' }]);
  // Applying it: everyone decided, nothing left to do.
  const r2 = roster(A, lobbyId, r1.msgId, a.body);
  const s2 = reduceLobby(lobbyId, [c, r1, ...joins, dupName, r2]);
  assert.deepEqual([...s2.joins.values()].map((j) => j.status), [...Array(9).fill('admitted'), 'rejected', 'rejected', 'rejected']);
  assert.deepEqual(adminNextAction(s2, A.pub, false), { kind: 'none' });
  assert.deepEqual(adminNextAction(s2, B.pub, false), { kind: 'none' }, 'not the admin');
  // A second join request from a current member is moot.
  const again = join(B, lobbyId);
  const s3 = reduceLobby(lobbyId, [c, r1, ...joins, dupName, r2, again]);
  assert.equal(s3.joins.get(again.msgId)?.status, 'admitted');
  assert.deepEqual(adminNextAction(s3, A.pub, false), { kind: 'none' });
});

test('leave: removed by the admin when no game is active, deferred otherwise; rejoin after leaving works', () => {
  const { msgs, lobbyId, members, head } = lobbyWith([B, C]);
  const lB = leave(B, lobbyId, members[1].joinId);
  let s = reduceLobby(lobbyId, [...msgs, lB]);
  assert.deepEqual([...s.leaves], [B.pub]);
  // Game active: membership changes are deferred, joins rejected with 'game-active' only.
  const jD = join(D, lobbyId);
  s = reduceLobby(lobbyId, [...msgs, lB, jD]);
  const active = adminNextAction(s, A.pub, true);
  assert.equal(active.kind, 'roster');
  if (active.kind !== 'roster') return;
  assert.deepEqual(active.body.members, members, 'rejection-only roster keeps members');
  assert.deepEqual(active.body.rejected, [{ joinId: jD.msgId, reason: 'game-active' }]);
  const rr = roster(A, lobbyId, head, active.body);
  s = reduceLobby(lobbyId, [...msgs, lB, jD, rr]);
  assert.equal(s.joins.get(jD.msgId)?.status, 'rejected');
  assert.equal(rejectionMessage(s.joins.get(jD.msgId)?.reason ?? ''), 'Cannot join while game is in progress');
  assert.deepEqual(adminNextAction(s, A.pub, true), { kind: 'none' });
  // Game over: the leaver is removed.
  const rem = adminNextAction(s, A.pub, false);
  assert.equal(rem.kind, 'roster');
  if (rem.kind !== 'roster') return;
  assert.deepEqual(rem.body.members.map((m) => m.name), ['ALICE', 'CAROL']);
  const r4 = roster(A, lobbyId, rr.msgId, rem.body);
  s = reduceLobby(lobbyId, [...msgs, lB, jD, rr, r4]);
  assert.deepEqual([...s.leaves], []);
  // B rejoins: the old leave (bound to the old joinId) does not apply to the new membership.
  const jB2 = join(B, lobbyId);
  s = reduceLobby(lobbyId, [...msgs, lB, jD, rr, r4, jB2]);
  assert.equal(s.joins.get(jB2.msgId)?.status, 'pending');
  const adm = adminNextAction(s, A.pub, false);
  assert.equal(adm.kind, 'roster');
  if (adm.kind !== 'roster') return;
  const r5 = roster(A, lobbyId, r4.msgId, adm.body);
  s = reduceLobby(lobbyId, [...msgs, lB, jD, rr, r4, jB2, r5]);
  assert.deepEqual(s.head.members.map((m) => m.name), ['ALICE', 'CAROL', 'BOB']);
  assert.deepEqual([...s.leaves], []);
  assert.equal(s.joins.get(jB2.msgId)?.status, 'admitted');
  // A leave that names somebody else's joinId does nothing.
  const forged = leave(C, lobbyId, jB2.msgId);
  assert.deepEqual([...reduceLobby(lobbyId, [...msgs, lB, jD, rr, r4, jB2, r5, forged]).leaves], []);
});

test('takeover and reclaim by the incumbent (§4.5)', () => {
  const { msgs, lobbyId, members, head } = lobbyWith([B, C]);
  const take = roster(B, lobbyId, head, { seq: 3, members, admin: B.pub });
  let s = reduceLobby(lobbyId, [...msgs, take]);
  assert.equal(s.head.admin, B.pub);
  // The new admin admits a joiner on the takeover branch.
  const jD = join(D, lobbyId);
  const bAdm = roster(B, lobbyId, take.msgId, { seq: 4, members: [...members, member(D, jD.msgId)] });
  s = reduceLobby(lobbyId, [...msgs, take, jD, bAdm]);
  assert.equal(s.joins.get(jD.msgId)?.status, 'admitted');
  // A sees it and reclaims at the parent of the takeover; not while a game is active; B does nothing.
  assert.deepEqual(adminNextAction(s, A.pub, true), { kind: 'none' });
  assert.deepEqual(adminNextAction(s, C.pub, false), { kind: 'none' });
  const bCfg = config(B, lobbyId, bAdm.msgId, [...members, member(D, jD.msgId), member(E, lobbyId)]);
  assert.deepEqual(adminNextAction(reduceLobby(lobbyId, [...msgs, take, jD, bAdm, bCfg]), A.pub, false), { kind: 'none' },
    'no reclaim once a game was configured on the takeover branch');
  const rec = adminNextAction(s, A.pub, false);
  assert.deepEqual(rec, { kind: 'roster', prev: head, body: { seq: 3, admin: A.pub, members, rejected: [], closed: false } });
  if (rec.kind !== 'roster' || rec.prev === undefined) return;
  const sib = roster(A, lobbyId, rec.prev, rec.body);
  s = reduceLobby(lobbyId, [...msgs, take, jD, bAdm, sib]);
  assert.equal(s.head.rosterId, sib.msgId, 'the incumbent sibling wins');
  // D's join is pending again on the winning branch and A admits it.
  assert.equal(s.joins.get(jD.msgId)?.status, 'pending');
  const next = adminNextAction(s, A.pub, false);
  assert.equal(next.kind, 'roster');
  if (next.kind === 'roster') assert.deepEqual(next.body.members.map((m) => m.name), ['ALICE', 'BOB', 'CAROL', 'DAVE']);
  // After a voluntary handoff there is nothing to reclaim.
  const h = roster(A, lobbyId, head, { seq: 3, members, admin: C.pub });
  const t2 = roster(B, lobbyId, h.msgId, { seq: 4, members, admin: B.pub });
  s = reduceLobby(lobbyId, [...msgs, h, t2]);
  assert.equal(s.head.admin, B.pub);
  assert.deepEqual(adminNextAction(s, A.pub, false), { kind: 'none' });
  const recC = adminNextAction(s, C.pub, false);
  assert.equal(recC.kind === 'roster' && recC.prev, h.msgId, 'C, the incumbent at h, reclaims');
});

test('current config and checkConfig (§4.6)', () => {
  const { msgs, lobbyId, members, head } = lobbyWith([B, C, D, E]);
  const cfg = config(A, lobbyId, head, members);
  const local = { activeGameIds: [] as string[] };
  let s = reduceLobby(lobbyId, [...msgs, cfg]);
  assert.equal(s.currentConfig?.configId, cfg.msgId);
  assert.deepEqual(checkConfig(s, C.pub, local), { ok: true, seat: 2 });
  assert.deepEqual(checkConfig(s, F.pub, local), { ok: false, reason: 'You are not seated in this game' });
  // Local conditions.
  const gameId = (cfg.env.body as GameConfig).gameId;
  assert.equal(checkConfig(s, C.pub, { activeGameIds: [gameId] }).ok, true, 'already accepted this game');
  assert.deepEqual(checkConfig(s, C.pub, { activeGameIds: ['other'] }), { ok: false, reason: 'You are in another game' });
  assert.equal(checkConfig(s, C.pub, { activeGameIds: [], knownGame: { gameId, configId: 'ff'.repeat(32) } }).ok, false);
  assert.equal(checkConfig(s, C.pub, { activeGameIds: [], knownGame: { gameId, configId: cfg.msgId } }).ok, true);
  // A rejection-only roster after the config does not stall acceptance.
  const jF = join(F, lobbyId);
  const rej = roster(A, lobbyId, head, { seq: 3, members, rejected: [{ joinId: jF.msgId, reason: 'game-active' }] });
  s = reduceLobby(lobbyId, [...msgs, cfg, jF, rej]);
  assert.equal(s.currentConfig?.configId, cfg.msgId);
  assert.deepEqual(checkConfig(s, B.pub, local), { ok: true, seat: 1 });
  // A membership change after the config does.
  const kick = roster(A, lobbyId, rej.msgId, { seq: 4, members: members.slice(0, 4) });
  s = reduceLobby(lobbyId, [...msgs, cfg, jF, rej, kick]);
  assert.equal(checkConfig(s, B.pub, local).ok, false);
  // Wrong author, wrong rules, seats not the members, invalid roles, bad seat count.
  const cases: [StoredMsg, RegExp][] = [
    [config(B, lobbyId, head, members), /No game configuration|not from the lobby admin/],
    [config(A, lobbyId, head, members, { rulesHash: '00'.repeat(32) }), /Reload to update/],
    [config(A, lobbyId, head, [...members.slice(0, 4), { pub: F.pub, name: 'FRANK', joinId: head }]), /do not match/],
    [config(A, lobbyId, head, [...members.slice(0, 4), { ...members[4], name: 'ZED' }]), /do not match/],
  ];
  for (const [m, re] of cases) {
    const st = reduceLobby(lobbyId, [...msgs, m]);
    const r = checkConfig(st, B.pub, local);
    assert.ok(!r.ok && re.test(r.reason), `${r.ok ? 'ok' : r.reason}`);
  }
  // Config equivocation: two configs with one gameId.
  const twin = config(A, lobbyId, head, [...members].reverse(), { gameId });
  s = reduceLobby(lobbyId, [...msgs, cfg, twin]);
  const r = checkConfig(s, B.pub, local);
  assert.ok(!r.ok && /two configurations/.test(r.reason));
  assert.deepEqual(conflictingConfigs(cfg.msgId, [...msgs, cfg, twin]).map((m) => m.msgId), [twin.msgId]);
  assert.deepEqual(conflictingConfigs(cfg.msgId, [...msgs, cfg]), []);
  // The latest config on the head chain is current; a config off the head chain is not.
  const r3 = roster(A, lobbyId, head, { seq: 3, members });
  const cfg2 = config(A, lobbyId, r3.msgId, members);
  s = reduceLobby(lobbyId, [...msgs, cfg, r3, cfg2]);
  assert.equal(s.currentConfig?.configId, cfg2.msgId);
  const side = roster(B, lobbyId, head, { seq: 3, members, admin: B.pub });   // loses to r3
  const cfgSide = config(B, lobbyId, side.msgId, members);
  s = reduceLobby(lobbyId, [...msgs, r3, side, cfgSide]);
  assert.equal(s.currentConfig, null);
  assert.deepEqual(checkConfig(s, B.pub, local), { ok: false, reason: 'No game configuration' });
});

test('candidates: several lobbies per code, sorted, closed ones dropped', () => {
  const c1 = create(A, 'QQQQ');
  const c2 = create(B, 'QQQQ');
  const c3 = create(C, 'QQQQ');
  const close3 = roster(C, c3.msgId, c3.msgId, { seq: 1, members: [], closed: true });
  const other = create(D, 'RRRR');
  const list = candidates('QQQQ', [c1, c2, c3, close3, other]);
  assert.deepEqual(list.map((x) => x.lobbyId), [c1.msgId, c2.msgId].sort());
  assert.deepEqual(list.map((x) => x.adminName).sort(), ['ALICE', 'BOB']);
});
