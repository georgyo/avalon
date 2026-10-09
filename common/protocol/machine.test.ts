/**
 * Machine tests (docs/p2p-protocol.md §12, WP-C): reduceGame properties (order
 * independence, idempotence, monotonicity) and every §3.7 rule with
 * transcripts constructed from recorded honest games.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexEncode, sha256, utf8 } from '../crypto/bytes.ts';
import { localCrypto, SeatDriver } from './driver.ts';
import { encodeEnvelope } from './envelope.ts';
import { reduceGame, resetMachineCaches, type GameEval } from './machine.ts';
import { computeOutcome } from './outcome.ts';
import { teamOf } from './rules.ts';
import type { Envelope, GameConfig, Hex32, StoredMsg, Transport } from './types.ts';
import type { GameOutcome } from './views.ts';
import { MemJournal, SIM_LOBBY_CODE } from '../testing/simulate.ts';
import { seededRng } from '../testing/memoryTransport.ts';
import {
  before, cancelMsg, chainOrder, digestBefore, evalFull, gameMsg, outcomeOf, positionOf, recordGame, revealMsg, signed, stepMsgs,
  withMsgs, without, type Recorded,
} from '../testing/transcript.ts';

const memo = new Map<string, Promise<Recorded>>();
function rec(name: 'A' | 'A2' | 'B' | 'C' | 'D'): Promise<Recorded> {
  let p = memo.get(name);
  if (p === undefined) {
    const o = {
      A: { n: 5, roles: ['MERLIN', 'PERCIVAL', 'MORGANA'], seed: 21, strategy: 'good-wins' as const },
      A2: { n: 5, roles: ['MERLIN', 'PERCIVAL', 'MORGANA'], seed: 25, strategy: 'merlin-dies' as const },
      B: { n: 5, roles: [], seed: 22, strategy: 'evil-wins' as const },
      C: { n: 5, roles: [], seed: 23, strategy: 'good-wins' as const },
      D: { n: 5, roles: [], seed: 24, strategy: 'reject' as const },
    }[name];
    p = recordGame(o);
    memo.set(name, p);
  }
  return p;
}

function ev(R: Recorded, msgs: ReadonlyMap<Hex32, StoredMsg>, extra?: { conflictingConfigs?: StoredMsg[] }): { ev: GameEval; out: GameOutcome | null } {
  const r = outcomeOf(R.t.config, R.t.configId, msgs, { configAuthor: R.t.signers[0].pub, ...extra });
  return { ev: r.ev, out: r.outcome };
}

function name(R: Recorded, seat: number): string {
  return R.t.config.seats[seat].name;
}

function seatOf(R: Recorded, m: StoredMsg): number {
  return R.t.config.seats.findIndex((s) => s.pub === m.env.author);
}

function steppedOnly(msgs: ReadonlyMap<Hex32, StoredMsg>): Map<Hex32, StoredMsg> {
  return without(msgs, (m) => m.env.type === 'reveal' || m.env.type === 'log' || m.env.type === 'cancel');
}

function reveals(R: Recorded, except: number[] = []): StoredMsg[] {
  return [...R.msgs.values()].filter((m) => m.env.type === 'reveal' && !except.includes(seatOf(R, m)));
}

function norm(e: GameEval): unknown {
  return { chain: e.chain, state: e.state, terminal: e.terminal, pending: e.pending, pendingReveals: e.pendingReveals, invalidReveals: e.invalidReveals };
}

function teamName(R: Recorded, seat: number): 'good' | 'evil' {
  const l = R.r.labels[seat];
  assert.ok(l !== null);
  return teamOf(l.role);
}

// ---------------------------------------------------------------- properties

test('reduceGame is order independent and idempotent (permutations, duplicates, driver ingestion)', async () => {
  const R = await rec('A');
  const full = evalFull(R.t.config, R.t.configId, R.msgs);
  const expectedOutcome = computeOutcome(R.t.config, full, R.msgs);
  assert.equal(full.terminal?.kind, 'natural');
  const list = [...R.msgs.values()];
  const rng = seededRng('perm', 1);
  for (let i = 0; i < 6; i++) {
    const perm = [...list].sort(() => rng() - 0.5);
    resetMachineCaches();
    const m = new Map(perm.map((x) => [x.msgId, x]));
    const e = evalFull(R.t.config, R.t.configId, m);
    assert.deepEqual(norm(e), norm(full));
    assert.deepEqual(computeOutcome(R.t.config, e, m), expectedOutcome);
  }
  // A passive driver ingesting every value twice, in a random order.
  const transport: Transport = { publish: async () => undefined, subscribe: () => () => undefined };
  const d = new SeatDriver({
    config: R.t.config, configId: R.t.configId, lobbyId: R.t.lobbyId, lobbyCode: SIM_LOBBY_CODE, seat: 1, signer: R.t.signers[1],
    secrets: null, transport, journal: new MemJournal(), crypto: localCrypto(), now: () => 0, onView: () => undefined,
    configAuthor: R.t.signers[0].pub,
  });
  const values = [...list, ...list].sort(() => rng() - 0.5);
  for (const m of values) d.ingest(m.env.type === 'key' || m.env.type === 'shuffle' || m.env.type === 'deal' || m.env.type.startsWith('ot.')
    ? `avalon/v1/game/${R.t.config.gameId}/setup#` : `avalon/v1/game/${R.t.config.gameId}/play#`, m.key, m.value);
  await d.idle();
  const de = d.evaluation;
  assert.ok(de !== null);
  assert.deepEqual(norm(de), norm(full));
  assert.deepEqual(d.outcome, expectedOutcome);
  d.stop();
});

test('prefixes: the chain grows monotonically and only the complete game is terminal; terminality is monotone', async () => {
  const R = await rec('A');
  const full = evalFull(R.t.config, R.t.configId, R.msgs);
  const ordered = chainOrder(full, steppedOnly(R.msgs));
  const lastStep = full.chain[full.chain.length - 1];
  let prevLen = 0;
  for (let k = 0; k <= ordered.length; k++) {
    const m = new Map(ordered.slice(0, k).map((x) => [x.msgId, x]));
    const e = evalFull(R.t.config, R.t.configId, m);
    assert.deepEqual(e.chain, full.chain.slice(0, e.chain.length), `prefix ${k}: chain is not a prefix`);
    assert.ok(e.chain.length >= prevLen, `prefix ${k}: chain shrank`);
    prevLen = e.chain.length;
    const complete = lastStep.msgIds.every((id) => m.has(id));
    assert.equal(e.terminal !== null, complete, `prefix ${k}: terminal ${JSON.stringify(e.terminal)}`);
  }
  // Supersets of a terminal set stay terminal (only the label may change).
  const terminalSet = steppedOnly(R.msgs);
  const extras = [cancelMsg(R.t, full, 2, 'p/1/0'), cancelMsg(R.t, full, 4, 'vc/2/0'), ...reveals(R)];
  for (let i = 0; i < extras.length; i++) {
    const e = evalFull(R.t.config, R.t.configId, withMsgs(terminalSet, ...extras.slice(0, i + 1)));
    assert.ok(e.terminal !== null);
  }
});

// ---------------------------------------------------------------- §3.7 rules

test('cancel at a setup step (abort at key) names the stalled seats; nothing was dealt', async () => {
  const R = await rec('A');
  const keys = stepMsgs(R, 'key');
  const m = new Map([0, 1, 2].map((j) => [(keys.get(j) as StoredMsg).msgId, keys.get(j) as StoredMsg]));
  const e0 = evalFull(R.t.config, R.t.configId, m);
  assert.equal(e0.pending?.step.id, 'key');
  assert.deepEqual(e0.pending?.missing, [3, 4]);
  const { ev: e, out } = ev(R, withMsgs(m, cancelMsg(R.t, e0, 0, 'key', 'abort')));
  assert.equal(e.terminal?.kind, 'canceled');
  assert.equal(e.terminal?.by, 0);
  assert.deepEqual(e.terminal?.cancel?.stalled, [3, 4]);
  assert.equal(out?.state, 'CANCELED');
  assert.equal(out?.message, `${name(R, 0)} aborted the start, waiting for ${name(R, 3)}, ${name(R, 4)}`);
  assert.deepEqual(out?.roles, []);
  assert.deepEqual(out?.stalled, [name(R, 3), name(R, 4)]);
  assert.equal(out?.canceledBy, name(R, 0));
});

test('cancel at a human step beats its completion; continuing afterwards is INVALID (canceled and continued)', async () => {
  const R = await rec('A');
  const base = before(R, 'p/0/0');
  const e0 = evalFull(R.t.config, R.t.configId, base);
  const proposer = (e0.pending?.step.req as number[])[0];
  const c = (proposer + 1) % 5;
  const cancel = cancelMsg(R.t, e0, c, 'p/0/0');
  let r = ev(R, withMsgs(base, cancel));
  assert.equal(r.ev.terminal?.kind, 'canceled');
  assert.equal(r.out?.message, `Canceled by ${name(R, c)}, waiting for ${name(R, proposer)}`);
  assert.deepEqual(r.out?.stalled, [name(R, proposer)]);
  // The proposal arrives later: the cancel still wins (human step, rule 5); nobody is stalled.
  const proposal = stepMsgs(R, 'p/0/0').get(proposer) as StoredMsg;
  r = ev(R, withMsgs(base, cancel, proposal));
  assert.equal(r.ev.terminal?.kind, 'canceled');
  assert.equal(r.ev.terminal?.atStep, 'p/0/0');
  assert.equal(r.out?.message, `Canceled by ${name(R, c)}`);
  assert.equal(r.out?.stalled, undefined);
  // The canceller's vote commit at vc/0/0 (a later natural-chain step): canceled and continued.
  const commit = stepMsgs(R, 'vc/0/0').get(c) as StoredMsg;
  r = ev(R, withMsgs(base, cancel, proposal, commit));
  assert.equal(r.ev.terminal?.kind, 'invalid');
  assert.equal(r.ev.terminal?.atStep, 'p/0/0');
  assert.deepEqual(r.ev.terminal?.faults.map((f) => [f.seat, f.reason]), [[c, 'canceled and continued']]);
  assert.deepEqual(r.ev.terminal?.basis, [cancel.msgId, commit.msgId].sort());
});

test('cancel at an automatic step: withholding is attributed; a non-terminal completion does not void the cancel', async () => {
  const R = await rec('A');
  const base = before(R, 'vr/0/0');
  const vr = stepMsgs(R, 'vr/0/0');
  const W = 2;
  const partial = withMsgs(base, ...[...vr].filter(([j]) => j !== W).map(([, m]) => m));
  const e0 = evalFull(R.t.config, R.t.configId, partial);
  assert.deepEqual(e0.pending?.missing, [W]);
  const cancel = cancelMsg(R.t, e0, W, 'vr/0/0');
  let r = ev(R, withMsgs(partial, cancel));
  assert.equal(r.ev.terminal?.cancel?.withholding, true);
  assert.equal(r.out?.message, `Canceled by ${name(R, W)} while withholding the vote`);
  assert.deepEqual(r.out?.stalled, [name(R, W)]);
  // W's own reveal completes vr/0/0 (approved, not terminal): the cancel stands (rule 5).
  r = ev(R, withMsgs(partial, cancel, vr.get(W) as StoredMsg));
  assert.equal(r.ev.terminal?.kind, 'canceled');
  assert.equal(r.out?.message, `Canceled by ${name(R, W)}`);
});

test('automatic-step completion with a terminal result beats a cancel at that step (rule 5)', async () => {
  const D = await rec('D');
  const full = steppedOnly(D.msgs);
  const e = evalFull(D.t.config, D.t.configId, full);
  assert.equal(e.terminal?.atStep, 'vr/0/4');
  let r = ev(D, withMsgs(full, cancelMsg(D.t, e, 1, 'vr/0/4')));
  assert.equal(r.ev.terminal?.kind, 'natural');
  assert.equal(r.out?.state, 'EVIL_WIN');
  assert.equal(r.out?.message, 'Five team proposals in a row rejected');
  const B = await rec('B');
  const fullB = steppedOnly(B.msgs);
  const eB = evalFull(B.t.config, B.t.configId, fullB);
  const last = eB.chain[eB.chain.length - 1].stepId;
  assert.match(last, /^mt\//);
  r = ev(B, withMsgs(fullB, cancelMsg(B.t, eB, 3, last)));
  assert.equal(r.ev.terminal?.kind, 'natural');
  assert.equal(r.out?.message, 'Three failed missions');
});

test('sore-loser cancel referencing an old digest: INVALID(canceled and continued), the canceller\'s team forfeits', async () => {
  const R = await rec('A');
  const full = evalFull(R.t.config, R.t.configId, R.msgs);
  for (const X of [0, 1, 2, 3, 4]) {
    const r = ev(R, withMsgs(R.msgs, cancelMsg(R.t, full, X, 'p/1/0')));
    assert.equal(r.ev.terminal?.kind, 'invalid');
    assert.equal(r.ev.terminal?.atStep, 'p/1/0');
    assert.equal(r.ev.terminal?.by, X);
    const team = teamName(R, X);
    assert.equal(r.out?.state, team === 'evil' ? 'GOOD_WIN' : 'EVIL_WIN');
    assert.equal(r.out?.message, `${name(R, X)} cheated (canceled and continued); ${team} forfeits`);
    assert.deepEqual(r.out?.cheaters, [{ name: name(R, X), reason: 'canceled and continued' }]);
  }
});

test('rule 2a: a tally contributor canceling the mt/m before the assassination is INVALID; a withholder is not', async () => {
  for (const which of ['A', 'A2'] as const) {
    const R = await rec(which);
    const full = evalFull(R.t.config, R.t.configId, R.msgs);
    const mt = full.chain[full.chain.length - 2].stepId;
    assert.match(mt, /^mt\//);
    assert.equal(full.chain[full.chain.length - 1].stepId, 'as');
    const assassin = full.state.assassination?.assassin;
    // A (missed assassination): an evil non-assassin cancels; A2 (Merlin assassinated): a good seat cancels.
    const X = which === 'A'
      ? R.r.labels.findIndex((l, j) => l !== null && teamOf(l.role) === 'evil' && j !== assassin)
      : R.r.labels.findIndex((l) => l !== null && teamOf(l.role) === 'good');
    const r = ev(R, withMsgs(R.msgs, cancelMsg(R.t, full, X, mt)));
    assert.equal(r.ev.terminal?.kind, 'invalid', which);
    assert.equal(r.ev.terminal?.atStep, mt);
    assert.deepEqual(r.ev.terminal?.faults.map((f) => [f.seat, f.reason]), [[X, 'canceled and continued']]);
    const team = teamName(R, X);
    assert.equal(team, which === 'A' ? 'evil' : 'good');
    assert.equal(r.out?.state, which === 'A' ? 'GOOD_WIN' : 'EVIL_WIN');
    assert.equal(r.out?.message, `${name(R, X)} cheated (canceled and continued); ${team} forfeits`);
  }
  // A withholder's cancel at that mt/m is valid; a third success WITH Merlin is not terminal, so 5a keeps CANCELED.
  const R = await rec('A');
  const full = evalFull(R.t.config, R.t.configId, R.msgs);
  const mt = full.chain[full.chain.length - 2].stepId;
  const W = 1;
  const base = withMsgs(before(R, mt), ...[...stepMsgs(R, mt)].filter(([j]) => j !== W).map(([, m]) => m));
  const e0 = evalFull(R.t.config, R.t.configId, base);
  const r = ev(R, withMsgs(base, cancelMsg(R.t, e0, W, mt), ...reveals(R)));
  assert.equal(r.ev.terminal?.kind, 'canceled');
  assert.equal(r.out?.state, 'CANCELED');
  assert.equal(r.out?.message, `Canceled by ${name(R, W)} while withholding the mission result`);
});

test('cancels during ASSASSINATION are ignored (rule 6)', async () => {
  const R = await rec('A');
  const base = before(R, 'as');
  const e0 = evalFull(R.t.config, R.t.configId, base);
  assert.equal(e0.pending?.step.id, 'as');
  const cancel = cancelMsg(R.t, e0, 0, 'as');
  let r = ev(R, withMsgs(base, cancel));
  assert.equal(r.ev.terminal, null);
  const as = stepMsgs(R, 'as');
  r = ev(R, withMsgs(base, cancel, ...as.values(), ...reveals(R)));
  assert.equal(r.ev.terminal?.kind, 'natural');
  assert.equal(r.out?.state, 'GOOD_WIN');
});

test('premature reveal: INVALID(revealed key during the game) at the pending step; a reveal citing it is ordinary', async () => {
  const R = await rec('A');
  const base = before(R, 'vc/1/0');
  const e0 = evalFull(R.t.config, R.t.configId, base);
  const r3 = revealMsg(R.t, 3, [], e0.head);
  let r = ev(R, withMsgs(base, r3));
  assert.equal(r.ev.terminal?.kind, 'invalid');
  assert.equal(r.ev.terminal?.atStep, 'vc/1/0');
  assert.deepEqual(r.ev.terminal?.faults, [{ seat: 3, stepId: 'vc/1/0', reason: 'revealed key during the game', evidence: [r3.msgId] }]);
  const team = teamName(R, 3);
  assert.equal(r.out?.message, `${name(R, 3)} cheated (revealed key during the game); ${team} forfeits`);
  // Two simultaneous premature reveals: both blamed, primary = lowest seat.
  const r1 = revealMsg(R.t, 1, [], e0.head);
  r = ev(R, withMsgs(base, r3, r1));
  assert.deepEqual(r.ev.terminal?.faults.map((f) => f.seat), [1, 3]);
  assert.equal(r.ev.terminal?.by, 1);
  // An honest end-of-game reveal citing the premature reveal is ordinary.
  const r0 = revealMsg(R.t, 0, [r3.msgId], e0.head);
  r = ev(R, withMsgs(base, r3, r0));
  assert.deepEqual(r.ev.terminal?.faults.map((f) => f.seat), [3]);
});

test('pending reveal: a reveal whose basis is missing suspends the game until the basis arrives', async () => {
  const R = await rec('A');
  const base = before(R, 'vc/1/0');
  const e0 = evalFull(R.t.config, R.t.configId, base);
  const cancel = cancelMsg(R.t, e0, 1, 'vc/1/0');
  const r3 = revealMsg(R.t, 3, [cancel.msgId], e0.head);
  let r = ev(R, withMsgs(base, r3));
  assert.equal(r.ev.terminal, null);
  assert.deepEqual(r.ev.pendingReveals, [r3.msgId]);
  r = ev(R, withMsgs(base, r3, cancel));
  assert.equal(r.ev.terminal?.kind, 'canceled');
  assert.equal(r.ev.terminal?.by, 1);
  assert.deepEqual(r.ev.pendingReveals, []);
  assert.deepEqual(r.out?.cheaters, []);
  // A bogus basis halts the game (pending forever) instead of letting play continue.
  const bogus = revealMsg(R.t, 2, [hexEncode(sha256(utf8('bogus')))], e0.head);
  r = ev(R, withMsgs(base, bogus));
  assert.equal(r.ev.terminal, null);
  assert.deepEqual(r.ev.pendingReveals, [bogus.msgId]);
});

test('rule 5a: a withheld third fail and a withheld third success without Merlin are restored from the reveals', async () => {
  for (const which of ['B', 'C'] as const) {
    const R = await rec(which);
    const full = evalFull(R.t.config, R.t.configId, R.msgs);
    const mt = full.chain[full.chain.length - 1].stepId;
    assert.match(mt, /^mt\//);
    const W = 4;
    const base = withMsgs(before(R, mt), ...[...stepMsgs(R, mt)].filter(([j]) => j !== W).map(([, m]) => m));
    const e0 = evalFull(R.t.config, R.t.configId, base);
    const cancel = cancelMsg(R.t, e0, W, mt);
    let r = ev(R, withMsgs(base, cancel));
    assert.equal(r.out?.state, 'CANCELED');
    assert.equal(r.out?.message, `Canceled by ${name(R, W)} while withholding the mission result`);
    r = ev(R, withMsgs(base, cancel, ...reveals(R)));
    const natural = which === 'B' ? 'Three failed missions' : 'Three missions succeeded';
    assert.equal(r.out?.state, which === 'B' ? 'EVIL_WIN' : 'GOOD_WIN');
    assert.equal(r.out?.message, `${natural} (${name(R, W)} withheld the tally)`);
    assert.equal(r.out?.final, true);
  }
});

test('rule 5a: a cancel at vr/m/4 whose reveals already hold a majority of rejections is the fifth rejection', async () => {
  const D = await rec('D');
  const W = 2;
  const base = withMsgs(before(D, 'vr/0/4'), ...[...stepMsgs(D, 'vr/0/4')].filter(([j]) => j !== W).map(([, m]) => m));
  const e0 = evalFull(D.t.config, D.t.configId, base);
  const r = ev(D, withMsgs(base, cancelMsg(D.t, e0, W, 'vr/0/4')));
  assert.equal(r.out?.state, 'EVIL_WIN');
  assert.equal(r.out?.message, `Five team proposals in a row rejected (${name(D, W)} withheld the vote)`);
});

test('a key whose prev names another config is absent, not INVALID', async () => {
  const R = await rec('A');
  const keys = stepMsgs(R, 'key');
  const other = hexEncode(sha256(utf8('another config')));
  const k2 = keys.get(2) as StoredMsg;
  const foreign = signed({ ...k2.env, prev: other } as Envelope, R.t.signers[2]);
  const m = new Map([...keys].filter(([j]) => j !== 2).map(([, x]) => [x.msgId, x]));
  m.set(foreign.msgId, foreign);
  const e = evalFull(R.t.config, R.t.configId, m);
  assert.equal(e.terminal, null);
  assert.equal(e.pending?.step.id, 'key');
  assert.deepEqual(e.pending?.missing, [2]);
});

test('config equivocation: INVALID(admin) at key, no honest seat blamed', async () => {
  const R = await rec('A');
  const otherConfig: GameConfig = { ...R.t.config, selectedRoles: ['MERLIN'] };
  const env: Envelope<'lobby.config'> = {
    v: 1, type: 'lobby.config', lobby: R.t.lobbyId, game: '', step: '', author: R.t.signers[0].pub,
    prev: hexEncode(sha256(utf8('roster'))), t: 1, body: otherConfig,
  };
  const enc = encodeEnvelope(env, R.t.signers[0]);
  const conflicting: StoredMsg = { msgId: enc.msgId, env, value: enc.value, key: enc.key };
  // Before any card exists: the game is void.
  const keys = new Map([...stepMsgs(R, 'key').values()].map((x) => [x.msgId, x]));
  let r = ev(R, keys, { conflictingConfigs: [conflicting] });
  assert.equal(r.ev.terminal?.kind, 'invalid');
  assert.equal(r.ev.terminal?.atStep, 'key');
  assert.deepEqual(r.ev.terminal?.faults.map((f) => [f.seat, f.reason]), [[0, 'config equivocation']]);
  assert.deepEqual(r.ev.terminal?.basis, [R.t.configId, conflicting.msgId].sort());
  assert.equal(r.out?.state, 'CANCELED');
  assert.equal(r.out?.message, `Game invalid: ${name(R, 0)} cheated (config equivocation)`);
  // Surfacing late (after the reveals): the admin's team forfeits.
  r = ev(R, R.msgs, { conflictingConfigs: [conflicting] });
  assert.equal(r.ev.terminal?.kind, 'invalid');
  assert.equal(r.out?.message, `${name(R, 0)} cheated (config equivocation); ${teamName(R, 0)} forfeits`);
});

test('elimination: one missing reveal is recovered; two good non-revealers forfeit an undetermined assassination', async () => {
  const R = await rec('A');
  // One non-revealer: role and votes by elimination, final.
  let r = ev(R, withMsgs(steppedOnly(R.msgs), ...reveals(R, [3])));
  assert.equal(r.out?.final, true);
  assert.deepEqual(r.out?.unrevealed, []);
  assert.equal(r.out?.roles[3].role, (R.r.labels[3] as { role: string }).role);
  // Target and Merlin unrevealed (both good): undetermined target, good forfeits.
  const target = R.ev.state.assassination?.target as number;
  const merlin = R.r.labels.findIndex((l) => l?.role === 'MERLIN');
  assert.notEqual(target, merlin);
  r = ev(R, withMsgs(steppedOnly(R.msgs), ...reveals(R, [target, merlin])));
  const names2 = [target, merlin].sort((a, b) => a - b).map((j) => name(R, j));
  assert.equal(r.out?.state, 'EVIL_WIN');
  assert.equal(r.out?.message, `Assassination unresolved: ${names2.join(' and ')} did not reveal; good forfeits`);
  assert.deepEqual(r.out?.unrevealed.filter((x) => names2.includes(x)), names2);
  // Target and an evil seat unrevealed (Merlin revealed): the target is not Merlin, good wins.
  const evil = R.r.labels.findIndex((l, j) => l !== null && teamOf(l.role) === 'evil' && j !== R.ev.state.assassination?.assassin);
  r = ev(R, withMsgs(steppedOnly(R.msgs), ...reveals(R, [target, evil])));
  assert.equal(r.out?.state, 'GOOD_WIN');
  assert.equal(r.out?.message, 'Three successful missions');
  // Merlin assassinated (A2), Merlin and an evil seat unrevealed: unresolved labels on both teams -> CANCELED.
  const A2 = await rec('A2');
  const t2 = A2.ev.state.assassination?.target as number;
  assert.equal(A2.r.labels[t2]?.role, 'MERLIN');
  const evil2 = A2.r.labels.findIndex((l, j) => l !== null && teamOf(l.role) === 'evil' && j !== A2.ev.state.assassination?.assassin);
  r = ev(A2, withMsgs(steppedOnly(A2.msgs), ...reveals(A2, [t2, evil2])));
  assert.equal(r.out?.state, 'CANCELED');
  assert.match(r.out?.message ?? '', /^Assassination unresolved: .* did not reveal$/);
});

test('INVALID forfeit rows: the cheater\'s team from one-team unresolved labels, else CANCELED', async () => {
  const R = await rec('A');
  const full = evalFull(R.t.config, R.t.configId, R.msgs);
  const goods = R.r.labels.map((l, j) => (l !== null && teamOf(l.role) === 'good' ? j : -1)).filter((j) => j >= 0);
  const evils = R.r.labels.map((l, j) => (l !== null && teamOf(l.role) === 'evil' ? j : -1)).filter((j) => j >= 0);
  const assassin = full.state.assassination?.assassin as number;
  const X = goods[0];
  const cancel = cancelMsg(R.t, full, X, 'p/1/0');
  // X and another good seat unrevealed: the unresolved labels are all good, so X's team is known.
  let r = ev(R, withMsgs(steppedOnly(R.msgs), cancel, ...reveals(R, [X, goods[1]])));
  assert.equal(r.out?.state, 'EVIL_WIN');
  assert.equal(r.out?.message, `${name(R, X)} cheated (canceled and continued); good forfeits`);
  // X and an evil non-assassin unrevealed: X's team is unknown -> CANCELED.
  const E = evils.find((j) => j !== assassin) as number;
  r = ev(R, withMsgs(steppedOnly(R.msgs), cancel, ...reveals(R, [X, E])));
  assert.equal(r.out?.state, 'CANCELED');
  assert.equal(r.out?.message, `Game invalid: ${name(R, X)} cheated (canceled and continued)`);
  assert.equal(positionOf(full, 'p/1/0') > 0, true);
  void digestBefore;
  void gameMsg;
  void reduceGame;
});
