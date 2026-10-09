/**
 * Regression tests for review findings on the game engine (docs/p2p-protocol.md
 * §3.6-3.7, §4.6, §5.10, §5.12): config equivocation is by the config's own
 * author only; a premature reveal beats a cancel at the same step; an honest
 * reveal is pending (not premature) while its basis step is still being
 * verified; a false assassination claim makes the claimant's team known; cards
 * exist only once the shuffles are verified.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexEncode, sha256, utf8 } from '../crypto/bytes.ts';
import { mul } from '../crypto/group.ts';
import { proveSigma } from '../crypto/sigma.ts';
import { openStatement } from '../crypto/statements.ts';
import { signerFromPair } from './envelope.ts';
import { conflictingConfigs } from './lobby.ts';
import { testPair } from './lobbyTestkit.ts';
import { dpt, ept, finalA, reduceGame, type GameEval } from './machine.ts';
import { computeOutcome } from './outcome.ts';
import { secretKey, seedRefOf } from './private.ts';
import { teamOf } from './rules.ts';
import type { Bodies, Envelope, GameConfig, Hex32, StoredMsg, Verdict } from './types.ts';
import type { GameOutcome } from './views.ts';
import {
  before, cancelMsg, digestBefore, evalFull, gameMsg, outcomeOf, positionOf, recordGame, revealMsg, signed, withMsgs, without,
  type Recorded,
} from '../testing/transcript.ts';

const memo = new Map<string, Promise<Recorded>>();
function rec(name: 'A' | 'R'): Promise<Recorded> {
  let p = memo.get(name);
  if (p === undefined) {
    p = recordGame(name === 'A'
      ? { n: 5, roles: ['MERLIN', 'PERCIVAL', 'MORGANA'], seed: 21, strategy: 'good-wins' }
      : { n: 5, roles: ['MERLIN', 'PERCIVAL', 'MORGANA'], seed: 301, strategy: 'random' });
    memo.set(name, p);
  }
  return p;
}

function seatOf(R: Recorded, m: StoredMsg): number {
  return R.t.config.seats.findIndex((s) => s.pub === m.env.author);
}

function faults(ev: GameEval): [number, string][] {
  return (ev.terminal?.faults ?? []).map((f) => [f.seat, f.reason]);
}

function eval1(R: Recorded, msgs: ReadonlyMap<Hex32, StoredMsg>, conflicting: StoredMsg[] = []): { ev: GameEval; out: GameOutcome | null } {
  const r = outcomeOf(R.t.config, R.t.configId, msgs, { configAuthor: R.t.signers[0].pub, lobbyId: R.t.lobbyId, conflictingConfigs: conflicting });
  return { ev: r.ev, out: r.outcome };
}

function configCopy(R: Recorded, by: ReturnType<typeof signerFromPair>, lobby: Hex32, over: Partial<GameConfig> = {}): StoredMsg {
  const env: Envelope<'lobby.config'> = {
    v: 1, type: 'lobby.config', lobby, game: '', step: '', author: by.pub,
    prev: hexEncode(sha256(utf8('some roster'))), t: 5, body: { ...R.t.config, ...over },
  };
  return signed(env, by);
}

test('config equivocation needs two configs by the config\'s author: copies by a seat or an outsider change nothing', async () => {
  const R = await rec('A');
  const base = eval1(R, R.msgs);
  assert.equal(base.ev.terminal?.kind, 'natural');
  assert.equal(base.out?.state, 'GOOD_WIN');
  const outsider = signerFromPair(testPair(9999));
  for (const by of [R.t.signers[3], outsider]) {
    const forged = configCopy(R, by, R.t.lobbyId, { options: { inGameLog: true } });
    // The lobby filter drops it, and reduceGame ignores it even when handed over directly.
    assert.deepEqual(conflictingConfigs(R.t.configId, [R.r.configMsg, forged]), []);
    const r = eval1(R, R.msgs, [forged]);
    assert.deepEqual(r.out, base.out);
    assert.equal(r.ev.terminal?.kind, 'natural');
  }
  // The admin's own second config of another lobby is no conflict either.
  const elsewhere = configCopy(R, R.t.signers[0], hexEncode(sha256(utf8('other lobby'))), { selectedRoles: ['MERLIN'] });
  assert.deepEqual(eval1(R, R.msgs, [elsewhere]).out, base.out);
  // The admin's second config of this lobby is equivocation: only the admin is blamed.
  const twin = configCopy(R, R.t.signers[0], R.t.lobbyId, { selectedRoles: ['MERLIN'] });
  assert.deepEqual(conflictingConfigs(R.t.configId, [R.r.configMsg, twin]).map((m) => m.msgId), [twin.msgId]);
  const r = eval1(R, R.msgs, [twin]);
  assert.deepEqual(faults(r.ev), [[0, 'config equivocation']]);
});

test('rule 4: a premature reveal beats a cancel at the same step; an earlier cancel still wins; a reveal citing the cancel is ordinary', async () => {
  const R = await rec('R');
  const step = 'vc/1/0';
  const base = before(R, step);
  const ev0 = evalFull(R.t.config, R.t.configId, base);
  assert.equal(ev0.pending?.step.id, step);
  const Z = 3;
  const W = 1;
  const premature = revealMsg(R.t, Z, [], ev0.head);
  let r = eval1(R, withMsgs(base, premature));
  assert.deepEqual(faults(r.ev), [[Z, 'revealed key during the game']]);
  // A cancel at the same step (a teammate, or an honest seat racing): INVALID still decides.
  const cancel = cancelMsg(R.t, ev0, W, step);
  r = eval1(R, withMsgs(base, premature, cancel));
  assert.equal(r.ev.terminal?.kind, 'invalid');
  assert.deepEqual(faults(r.ev), [[Z, 'revealed key during the game']]);
  assert.match(r.out?.message ?? '', /DAVE cheated \(revealed key during the game\)/);
  // An honest reveal citing that cancel is an ordinary end-of-game reveal (nobody else is blamed).
  const honest = revealMsg(R.t, 2, [cancel.msgId], ev0.head);
  r = eval1(R, withMsgs(base, cancel, honest));
  assert.equal(r.ev.terminal?.kind, 'canceled');
  assert.deepEqual(r.out?.cheaters, []);
  r = eval1(R, withMsgs(base, cancel, honest, premature));
  assert.deepEqual(faults(r.ev), [[Z, 'revealed key during the game']]);
  // A valid cancel at an earlier step (by a seat with no later message) wins over the premature reveal.
  const pIdx = positionOf(ev0, 'p/1/0');
  const proposer = seatOf(R, R.msgs.get(ev0.chain[pIdx].msgIds[0]) as StoredMsg);
  const X = [0, 1, 2, 3, 4].find((j) => j !== proposer && j !== Z) as number;
  const early = cancelMsg(R.t, ev0, X, 'p/1/0');
  r = eval1(R, withMsgs(base, premature, early));
  assert.equal(r.ev.terminal?.kind, 'canceled');
  assert.equal(r.ev.terminal?.atStep, 'p/1/0');
});

test('rule 3: an honest end-of-game reveal is pending, not premature, while an extra claim at `as` is unverified', async () => {
  const R = await rec('A');
  const verdicts = new Map<Hex32, Verdict>();
  const full = evalFull(R.t.config, R.t.configId, R.msgs, { verdicts });
  assert.equal(full.terminal?.kind, 'natural');
  const asMsg = [...R.msgs.values()].find((m) => m.env.type === 'assassinate') as StoredMsg;
  const assassin = seatOf(R, asMsg);
  const other = (assassin + 1) % 5;
  const k = positionOf(full, 'as');
  const fake = gameMsg(R.t, other, 'assassinate', 'as', digestBefore(full, R.t.configId, k),
    { ...(asMsg.env.body as Bodies['assassinate']), target: (other + 2) % 5 });
  const msgs = withMsgs(R.msgs, fake);
  const e = reduceGame({
    config: R.t.config, configId: R.t.configId, lobbyId: R.t.lobbyId, msgs, verdicts, conflictingConfigs: [], configAuthor: R.t.signers[0].pub,
  });
  assert.equal(e.terminal, null, JSON.stringify(e.terminal?.faults));
  assert.equal(e.pendingReveals.length, 5);
  assert.ok(e.jobs.some((j) => j.id === fake.msgId));
  // Once verified, only the junk claim's author is blamed.
  const e2 = evalFull(R.t.config, R.t.configId, msgs, { verdicts });
  assert.deepEqual(faults(e2), [[other, 'invalid assassination proof']]);
});

test('§5.10: a valid opening of a non-assassin card at `as` makes the claimant\'s team known for the forfeit', async () => {
  const R = await rec('A');
  const full = evalFull(R.t.config, R.t.configId, R.msgs);
  const assassin = full.state.assassination?.assassin as number;
  const labels = R.r.labels.map((l) => l as { role: string; assassin: boolean });
  const X = labels.findIndex((l, j) => j !== assassin && teamOf(l.role) === 'good');
  const E = labels.findIndex((l, j) => j !== assassin && teamOf(l.role) === 'evil');
  assert.ok(X >= 0 && E >= 0);
  const k = positionOf(full, 'as');
  const prev = digestBefore(full, R.t.configId, k);
  const x = secretKey(R.t.config, R.t.secrets[X]);
  const A = dpt((finalA(full.state) as string[])[X]);
  const Oa = mul(A, x);
  const y = dpt((full.state.y as string[])[X]);
  const proof = proveSigma(openStatement({ configId: R.t.configId, stepId: 'as', prover: R.t.signers[X].pub }, y, A, Oa), 0, [x],
    seedRefOf(R.t.config, R.t.secrets[X]));
  const claim = gameMsg(R.t, X, 'assassinate', 'as', prev, { target: (X + 1) % 5 === X ? 0 : (X + 1) % 5, open: ept(Oa), proof });
  // X and an evil seat do not reveal: the unresolved labels span both teams, yet X's card was opened.
  const msgs = withMsgs(without(R.msgs, (m) => m.env.type === 'reveal' && [X, E].includes(seatOf(R, m))), claim);
  const r = eval1(R, msgs);
  assert.deepEqual(faults(r.ev), [[X, 'false assassination claim']]);
  assert.equal(r.out?.roles[X].role, labels[X].role);
  assert.equal(r.out?.state, 'EVIL_WIN');
  assert.match(r.out?.message ?? '', /cheated \(false assassination claim\); good forfeits$/);
});

test('§5.12: cards (and roles) exist only once every shuffle of the final deck is verified', async () => {
  const R = await rec('A');
  const base = before(R, 'deal');
  const ev0 = evalFull(R.t.config, R.t.configId, base);
  const cancel = cancelMsg(R.t, ev0, 1, 'deal');
  const reveals = [0, 1, 2, 3, 4].map((j) => revealMsg(R.t, j, [cancel.msgId], ev0.head));
  const msgs = withMsgs(base, cancel, ...reveals);
  const verdicts = new Map<Hex32, Verdict>();
  const full = evalFull(R.t.config, R.t.configId, msgs, { verdicts });
  assert.equal(full.shufflesVerified, true);
  const known = computeOutcome(R.t.config, full, msgs);
  assert.equal(known?.roles.length, 5);
  assert.deepEqual(known?.roles.map((x) => x.role), R.r.labels.map((l) => l?.role));
  // Same transcript, shuffle verdicts unknown: no cards, no roles, no (audit) cheaters.
  const partial = new Map(verdicts);
  for (const id of full.state.shuffleIds) partial.delete(id);
  const e = reduceGame({
    config: R.t.config, configId: R.t.configId, lobbyId: R.t.lobbyId, msgs, verdicts: partial, conflictingConfigs: [], configAuthor: R.t.signers[0].pub,
  });
  assert.equal(e.terminal?.kind, 'canceled');
  assert.equal(e.shufflesVerified, false);
  const out = computeOutcome(R.t.config, e, msgs);
  assert.deepEqual(out?.roles, []);
  assert.deepEqual(out?.cheaters, []);
  assert.equal(out?.state, 'CANCELED');
});
