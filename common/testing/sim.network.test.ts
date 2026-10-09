/**
 * Simulations under adverse conditions (docs/p2p-protocol.md §12): reload of a
 * seat at every step, delays/reordering/duplication/drops, partitions, an
 * empty relay restart, selective withholding of a deciding cancel, and two
 * non-revealers after an assassination.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, simConfig, simGameSeed, type SimOptions, type SimResult } from './simulate.ts';
import { predictDeal } from './predict.ts';
import { assertAgreement, assertHonestGame } from './simkit.ts';

const BASE: SimOptions = { n: 5, roles: ['MERLIN', 'PERCIVAL', 'MORGANA'], seed: 31, strategy: 'random' };

let baseline: Promise<SimResult> | null = null;
function base(): Promise<SimResult> {
  baseline ??= simulate(BASE);
  return baseline;
}

test('baseline game is honest and complete', async () => {
  const r = await base();
  assertHonestGame(r);
  assert.ok((r.ev?.chain.length ?? 0) > 20);
});

test('reload: replacing a seat\'s driver at every step yields a byte-identical transcript', async () => {
  const r0 = await base();
  const steps = (r0.ev?.chain ?? []).map((c) => c.stepId);
  const reloadAt = [...steps, 'end'].map((step, i) => ({ seat: i % 5, step }));
  const r1 = await simulate({ ...BASE, reloadAt });
  assert.equal(r1.reloads, reloadAt.length);
  assertHonestGame(r1);
  assert.deepEqual(r1.transcript, r0.transcript);
  // Reloading every seat at the same step, twice in a row.
  const r2 = await simulate({ ...BASE, reloadAt: [0, 1, 2, 3, 4].flatMap((seat) => [{ seat, step: 'deal' }, { seat, step: 'otS' }, { seat, step: 'vr/0/0' }]) });
  assert.deepEqual(r2.transcript, r0.transcript);
});

test('network: delays, reordering, duplication and 10% drops do not change the transcript', async () => {
  const r0 = await base();
  const r = await simulate({ ...BASE, net: { delayMs: [1, 400], dropRate: 0.1, duplicateRate: 0.2, reorder: true } });
  assertHonestGame(r);
  assert.deepEqual(r.transcript, r0.transcript);
});

test('network: a partition during play heals; the game completes identically', async () => {
  const r0 = await base();
  let done = false;
  const r = await simulate({
    ...BASE,
    onEval: (seat, ev, sim) => {
      if (done || seat !== 0 || ev.pending?.step.id !== 'vc/0/0') return;
      done = true;
      sim.transport.partition([[sim.peers[0], sim.peers[1], sim.peers[2]], [sim.peers[3], sim.peers[4]]]);
      sim.transport.schedule(5000, () => sim.transport.heal());
    },
  });
  assert.ok(done);
  assertHonestGame(r);
  assert.deepEqual(r.transcript, r0.transcript);
});

test('relay restartEmpty(): clients republish their journals and transcripts; the game completes identically', async () => {
  const r0 = await base();
  const restarts: string[] = [];
  const r = await simulate({
    ...BASE,
    onEval: (seat, ev, sim) => {
      for (const at of ['otR', 'mv/0', 'vr/1/0']) {
        if (seat === 3 && !restarts.includes(at) && ev.pending?.step.id === at) {
          restarts.push(at);
          sim.transport.restartEmpty();
        }
      }
    },
  });
  assert.ok(restarts.length >= 2, `restarts: ${restarts.join(',')}`);
  assertHonestGame(r);
  assert.deepEqual(r.transcript, r0.transcript);
});

test('selective withholding: a peer missing the deciding cancel sees the reveals as pending, never premature', async () => {
  const W = 4;
  let cancelId: string | null = null;
  let dropped = 0;
  let sawPending = false;
  let sawPremature = false;
  const r = await simulate({
    ...BASE,
    cancelAt: [{ seat: 1, step: 'vc/1/0' }],
    onEval: (seat, ev, sim) => {
      if (seat === 1 && cancelId === null) {
        const c = sim.drivers[1].messages().find((m) => m.env.type === 'cancel' && m.env.author === sim.signers[1].pub);
        if (c !== undefined) {
          cancelId = c.key;
          sim.peers[W].dropIncoming = (_soul, key) => key === cancelId && dropped++ < 3;
        }
      }
      if (seat === W) {
        if (ev.pendingReveals.length > 0) sawPending = true;
        if (ev.terminal?.faults.some((f) => f.reason === 'revealed key during the game') === true) sawPremature = true;
      }
    },
  });
  assert.ok(cancelId !== null);
  assert.ok(dropped >= 1);
  assert.equal(sawPremature, false);
  assert.equal(sawPending, true, 'the withheld peer never saw a pending reveal');
  const out = assertAgreement(r);
  assert.equal(out.state, 'CANCELED');
  assert.match(out.message, new RegExp(`^Canceled by ${r.config.seats[1].name}`));
  assert.deepEqual(out.cheaters, []);
  assert.equal(r.seats[W].ev?.terminal?.kind, 'canceled');
});

test('two non-revealers after Merlin is assassinated (Merlin and a Loyal Follower): EVIL_WIN, good forfeits', async () => {
  const opts: SimOptions = { n: 5, roles: ['MERLIN', 'PERCIVAL', 'MORGANA'], seed: 32, strategy: 'merlin-dies' };
  const { config, configMsg } = simConfig(opts.n, opts.roles, opts.seed);
  const deal = predictDeal(config, configMsg.msgId, Array.from({ length: 5 }, (_, j) => ({ gameSeed: simGameSeed(opts.seed, j) })));
  const merlin = deal.labels.findIndex((l) => l.role === 'MERLIN');
  const lf = deal.labels.findIndex((l) => l.role === 'LOYAL FOLLOWER');
  const r = await simulate({ ...opts, stall: [{ seat: merlin, at: 'end' }, { seat: lf, at: 'end' }] });
  assert.deepEqual(r.labels.map((l) => l?.role), deal.labels.map((l) => l.role));
  const honest = [0, 1, 2, 3, 4].filter((j) => j !== merlin && j !== lf);
  const out = assertAgreement(r, honest);
  const names = [merlin, lf].sort((a, b) => a - b).map((j) => r.config.seats[j].name);
  assert.equal(out.state, 'EVIL_WIN');
  assert.equal(out.message, `Assassination unresolved: ${names.join(' and ')} did not reveal; good forfeits`);
  assert.equal(out.assassinated, r.config.seats[merlin].name);
  assert.equal(out.final, false);
  assert.deepEqual(out.unrevealed.filter((x) => names.includes(x)), names);
});
