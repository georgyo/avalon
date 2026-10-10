/**
 * Regression tests for review findings on the SeatDriver and the builders
 * (docs/p2p-protocol.md §3.7, §3.9, §3.10, §5.11, §7.7): a cancel racing the
 * completion of a step never blames the honest canceller; a suspended driver
 * cancels without publishing its automatic message; a driver stopped while
 * publishing journals nothing; a reloaded driver re-puts its reveal's basis;
 * a cancel without secrets first syncs its own earlier messages; builders
 * refuse to run outside their gates or without secrets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localCrypto, SeatDriver } from './driver.ts';
import { soulOf } from './envelope.ts';
import { runProve, type BuildTask } from './jobs.ts';
import type { GameEval } from './machine.ts';
import type { BuildCtx } from './build.ts';
import { derivePrivate } from './private.ts';
import { computeOutcome } from './outcome.ts';
import type { Bodies, Journal, StoredMsg, Transport } from './types.ts';
import { MemJournal, SIM_LOBBY_CODE } from '../testing/simulate.ts';
import { before, evalFull, positionOf, recordGame, revealMsg, stepMsgs, withMsgs, type Recorded } from '../testing/transcript.ts';

const memo = new Map<string, Promise<Recorded>>();
function rec(name: 'M' | 'A'): Promise<Recorded> {
  let p = memo.get(name);
  if (p === undefined) {
    p = recordGame(name === 'M'
      ? { n: 5, roles: ['MERLIN', 'ASSASSIN'], seed: 7, strategy: 'good-wins' }
      : { n: 5, roles: ['MERLIN', 'PERCIVAL', 'MORGANA'], seed: 21, strategy: 'good-wins' });
    memo.set(name, p);
  }
  return p;
}

const silent: Transport = { publish: async () => undefined, subscribe: () => () => undefined };

function seatOf(R: Recorded, m: StoredMsg): number {
  return R.t.config.seats.findIndex((s) => s.pub === m.env.author);
}

function driverFor(R: Recorded, seat: number, journal: Journal, o?: { transport?: Transport; secrets?: null }): SeatDriver {
  return new SeatDriver({
    config: R.t.config, configId: R.t.configId, lobbyId: R.t.lobbyId, lobbyCode: SIM_LOBBY_CODE, seat, signer: R.t.signers[seat],
    secrets: o?.secrets === null ? null : R.t.secrets[seat], transport: o?.transport ?? silent, journal, crypto: localCrypto(),
    now: () => 1, onView: () => undefined, configAuthor: R.t.signers[0].pub,
  });
}

function feed(d: SeatDriver, msgs: Iterable<StoredMsg>): void {
  for (const m of msgs) d.ingest(soulOf(m.env, SIM_LOBBY_CODE), m.key, m.value);
}

async function journalOwn(R: Recorded, seat: number, msgs: Iterable<StoredMsg>): Promise<MemJournal> {
  const j = new MemJournal();
  for (const m of msgs) if (seatOf(R, m) === seat) await j.put(R.t.configId, m.env.step, m.value);
  return j;
}

/**
 * The user of seat X clicks Cancel at human step `stepId` while the last
 * message of that step (by another seat) arrives, `delay` microtasks earlier.
 */
async function raceTrial(R: Recorded, stepId: string, delay: number): Promise<{ ev: GameEval; result: string; mine: StoredMsg[] }> {
  const k = positionOf(R.ev, stepId);
  const ids = R.ev.chain[k].msgIds;
  const last = R.msgs.get(ids[ids.length - 1]) as StoredMsg;
  const X = seatOf(R, R.msgs.get(ids[0]) as StoredMsg);
  const prior = [...before(R, stepId).values(), ...ids.slice(0, -1).map((id) => R.msgs.get(id) as StoredMsg)];
  const d = driverFor(R, X, await journalOwn(R, X, prior));
  await d.start();
  feed(d, prior);
  await d.idle();
  assert.equal(d.evaluation?.pending?.step.id, stepId);
  feed(d, [last]);
  for (let i = 0; i < delay; i++) await Promise.resolve();
  const result = await d.cancel('cancel').then(() => 'ok', (e: unknown) => (e instanceof Error ? e.message : String(e)));
  await d.idle();
  const ev = d.evaluation as GameEval;
  const mine = d.messages().filter((m) => seatOf(R, m) === X);
  d.stop();
  return { ev, result, mine };
}

test('a cancel racing the last ballot at mv/m (two successes, MERLIN) never blames the honest canceller', async () => {
  const R = await rec('M');
  const mv = R.ev.chain.find((c, i) => c.stepId.startsWith('mv/') && R.ev.chain.slice(0, i).filter((x) => x.stepId.startsWith('mt/')).length === 2);
  assert.ok(mv !== undefined);
  const outcomes = new Set<string>();
  for (let delay = 0; delay <= 12; delay++) {
    const { ev, result, mine } = await raceTrial(R, mv.stepId, delay);
    assert.notEqual(ev.terminal?.kind, 'invalid', `delay ${delay}: ${JSON.stringify(ev.terminal?.faults)}`);
    const cancel = mine.find((m) => m.env.type === 'cancel');
    const tally = mine.find((m) => m.env.type === 'tally');
    if (cancel !== undefined) {
      // A cancel at mv/m: the own tally was never published after it (§3.7 rule 2).
      assert.equal(tally, undefined, `delay ${delay}`);
      assert.equal((cancel.env.body as Bodies['cancel']).at, mv.stepId);
      assert.equal(ev.terminal?.kind, 'canceled');
      outcomes.add('canceled');
    } else {
      // The step completed first: the click published the tally and stopped there (rule 2a).
      assert.equal(result, 'Canceling now would forfeit', `delay ${delay}`);
      assert.ok(tally !== undefined);
      outcomes.add('forfeit-refused');
    }
  }
  assert.ok(outcomes.size >= 1);
});

test('a cancel racing the last vote commit never blames the honest canceller', async () => {
  const R = await rec('A');
  for (let delay = 0; delay <= 12; delay++) {
    const { ev, mine } = await raceTrial(R, 'vc/0/0', delay);
    assert.notEqual(ev.terminal?.kind, 'invalid', `delay ${delay}: ${JSON.stringify(ev.terminal?.faults)}`);
    assert.equal(ev.terminal?.kind, 'canceled', `delay ${delay}`);
    const cancel = mine.find((m) => m.env.type === 'cancel') as StoredMsg;
    const at = (cancel.env.body as Bodies['cancel']).at;
    // Nothing of this seat at a step after the one it canceled.
    const atPos = positionOf(ev, at);
    for (const m of mine) {
      if (m.env.type === 'cancel' || m.env.type === 'reveal') continue;
      assert.ok(positionOf(ev, m.env.step) <= atPos, `delay ${delay}: ${m.env.step} after cancel at ${at}`);
    }
  }
});

test('while a reveal is pending, cancel publishes nothing but the cancel (no tally, §7.7)', async () => {
  const R = await rec('A');
  const base = before(R, 'mt/0');
  const ev0 = evalFull(R.t.config, R.t.configId, base);
  assert.equal(ev0.pending?.step.id, 'mt/0');
  // Seat 4 revealed citing a message this device does not have: the reveal is pending.
  const bogus = revealMsg(R.t, 4, ['ab'.repeat(32)], ev0.head);
  const X = 1;
  const d = driverFor(R, X, await journalOwn(R, X, base.values()));
  // Ingest before start: the reveal is pending from the first evaluation on, so no tally is ever built.
  feed(d, [...base.values(), bogus]);
  await d.start();
  await d.idle();
  assert.deepEqual(d.evaluation?.pendingReveals, [bogus.msgId]);
  await d.cancel('cancel');
  await d.idle();
  const mine = d.messages().filter((m) => seatOf(R, m) === X);
  assert.equal(mine.some((m) => m.env.type === 'tally'), false);
  const cancel = mine.find((m) => m.env.type === 'cancel') as StoredMsg;
  assert.equal((cancel.env.body as Bodies['cancel']).at, 'mt/0');
  d.stop();
});

test('a driver stopped between building and journaling a message journals and sends nothing', async () => {
  const R = await rec('A');
  const sent: string[] = [];
  const transport: Transport = { publish: async (_s, key) => void sent.push(key), subscribe: () => () => undefined };
  const inner = new MemJournal();
  let d: SeatDriver | null = null;
  let cancelReads = 0;
  // The second read of the 'cancel' slot happens after the build, right before the put: stop there.
  const journal: Journal = {
    get: async (scope, slot) => {
      if (slot === 'cancel' && ++cancelReads === 2) d?.stop();
      return inner.get(scope, slot);
    },
    put: (scope, slot, value) => inner.put(scope, slot, value),
    putIfAbsent: (scope, slot, value) => inner.putIfAbsent(scope, slot, value),
    all: (scope) => inner.all(scope),
  };
  d = driverFor(R, 2, journal, { transport });
  await d.start();
  await d.idle();
  assert.equal(cancelReads, 2);
  assert.deepEqual(await inner.all(R.t.configId), []);
  assert.deepEqual(sent, []);
});

test('after a reload, the journaled reveal\'s basis envelopes are re-put as soon as they are known', async () => {
  const R = await rec('A');
  const sent: string[] = [];
  const transport: Transport = { publish: async (_s, key) => void sent.push(key), subscribe: () => () => undefined };
  const anyReveal = [...R.msgs.values()].find((m) => m.env.type === 'reveal') as StoredMsg;
  const basis = (anyReveal.env.body as Bodies['reveal']).basis;
  const basisMsgs = basis.map((id) => R.msgs.get(id) as StoredMsg);
  assert.ok(basisMsgs.length > 0 && basisMsgs.every((m) => m !== undefined));
  // A seat that authored none of the basis envelopes (they are not in its journal).
  const X = [0, 1, 2, 3, 4].find((j) => basisMsgs.every((m) => seatOf(R, m) !== j)) as number;
  const journal = await journalOwn(R, X, R.msgs.values());
  const own = [...R.msgs.values()].find((m) => m.env.type === 'reveal' && seatOf(R, m) === X) as StoredMsg;
  assert.deepEqual((own.env.body as Bodies['reveal']).basis, basis);
  await journal.put(R.t.configId, 'reveal', own.value);
  const d = driverFor(R, X, journal, { transport });
  await d.start();
  assert.ok(sent.includes(own.key));
  assert.ok(basisMsgs.every((m) => !sent.includes(m.key)));
  feed(d, basisMsgs);
  for (const m of basisMsgs) assert.ok(sent.includes(m.key), `basis ${m.env.step} not re-put`);
  d.stop();
});

test('a cancel without secrets (lost storage) waits for its own earlier messages to sync and targets the step after them', async () => {
  const R = await rec('A');
  const X = 2;
  const vc = stepMsgs(R, 'vc/0/0');
  const ownCommit = vc.get(X) as StoredMsg;
  const k = positionOf(R.ev, 'mv/0');
  const known = new Set(R.ev.chain.slice(0, k).flatMap((c) => c.msgIds));
  const upTo = [...R.msgs.values()].filter((m) => known.has(m.msgId));
  // The relay holds everything up to mv/0, but this device's own messages from vc/0/0 on arrive late.
  const late = upTo.filter((m) => seatOf(R, m) === X && positionOf(R.ev, m.env.step) >= positionOf(R.ev, 'vc/0/0'));
  assert.ok(late.includes(ownCommit));
  const early = upTo.filter((m) => !late.includes(m));
  const subs = new Map<string, (key: string, value: string) => void>();
  let syncCalls = 0;
  const transport: Transport = {
    publish: async () => undefined,
    subscribe: (soul, cb) => {
      subs.set(soul, cb);
      return () => subs.delete(soul);
    },
    synced: async (soul) => {
      syncCalls++;
      for (const m of late) if (soulOf(m.env, SIM_LOBBY_CODE) === soul) subs.get(soul)?.(m.key, m.value);
    },
  };
  const d = driverFor(R, X, new MemJournal(), { transport, secrets: null });
  await d.start();
  feed(d, early);
  await d.idle();
  assert.equal(d.evaluation?.pending?.step.id, 'vc/0/0');
  await d.cancel('lost');
  await d.idle();
  assert.equal(syncCalls, 2);
  const cancel = d.messages().find((m) => m.env.type === 'cancel' && seatOf(R, m) === X) as StoredMsg;
  assert.equal((cancel.env.body as Bodies['cancel']).at, 'mv/0');
  // With the whole transcript (all of X's messages), the cancel is valid: no fault for X.
  const all = withMsgs(new Map(upTo.map((m) => [m.msgId, m])), cancel);
  const full = evalFull(R.t.config, R.t.configId, all);
  assert.equal(full.terminal?.kind, 'canceled');
  assert.match(computeOutcome(R.t.config, full, all)?.message ?? '', new RegExp(`^${R.t.config.seats[X].name} lost their game keys`));
  d.stop();
});

test('builders: no secrets, no build (except cancel); gates and suspension are enforced', async () => {
  const R = await rec('A');
  const ctxAt = (stepId: string, over?: Partial<GameEval>, seat = 1): BuildCtx => {
    const ev = evalFull(R.t.config, R.t.configId, before(R, stepId));
    return {
      config: R.t.config, configId: R.t.configId, lobbyId: R.t.lobbyId, seat, me: R.t.signers[seat].pub,
      ev: { ...ev, jobs: [], ...over }, secrets: R.t.secrets[seat], priv: null, now: 1,
    };
  };
  const run = (task: BuildTask): string => {
    try {
      runProve(task);
      return 'ok';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  // Lost secrets: key refused, cancel fine.
  const keyCtx = { ...ctxAt('key'), secrets: null };
  assert.match(run({ kind: 'build', fn: 'key', ctx: keyCtx }), /lost the secret keys/);
  assert.equal(run({ kind: 'build', fn: 'cancel', ctx: keyCtx, reason: 'lost' }), 'ok');
  // Suspended (a reveal pending): tally and vote commit refused; cancel fine.
  const mt = ctxAt('mt/0', { pendingReveals: ['ab'.repeat(32)] });
  assert.match(run({ kind: 'build', fn: 'tally', ctx: mt }), /Suspended/);
  assert.equal(run({ kind: 'build', fn: 'cancel', ctx: mt, reason: 'cancel' }), 'ok');
  assert.match(run({ kind: 'build', fn: 'voteCommit', ctx: ctxAt('vc/0/0', { pendingReveals: ['ab'.repeat(32)] }), approve: true }), /Suspended/);
  // ot.send releases E_{Q,r} only after every U_Q was proven (otR complete).
  const otS = ctxAt('otS');
  const priv = derivePrivate(R.t.config, otS.ev, otS.seat, R.t.secrets[otS.seat]);
  assert.ok(priv !== null);
  assert.equal(run({ kind: 'build', fn: 'otSend', ctx: { ...otS, priv } }), 'ok');
  const otSNoU = { ...otS, priv, ev: { ...otS.ev, state: { ...otS.ev.state, U: null } } };
  assert.match(run({ kind: 'build', fn: 'otSend', ctx: otSNoU }), /receiver commitments unknown/);
  // A closed gate (shuffle verdicts unknown at deal) refuses the deal.
  const deal = ctxAt('deal');
  const closed = { ...deal, ev: { ...deal.ev, pending: deal.ev.pending === null ? null : { ...deal.ev.pending, gateOpen: false } } };
  assert.match(run({ kind: 'build', fn: 'deal', ctx: closed }), /Gate closed|gate closed/);
});
