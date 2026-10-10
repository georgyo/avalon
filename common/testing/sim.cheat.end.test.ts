/**
 * Cheating around the end of the game and cancels (docs/p2p-protocol.md §3.7,
 * §10, §12): premature reveals (with an empty and with a bogus basis),
 * sore-loser cancels after the result is known, cancels during the
 * assassination, contributor cancels at the mt/m before an assassination, and
 * withholding the last tally share then canceling (rule 5a).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encScalar } from '../crypto/group.ts';
import type { GameEval } from '../protocol/machine.ts';
import { secretKey } from '../protocol/private.ts';
import { teamOf } from '../protocol/rules.ts';
import { simulate, SIM_T, type SimOptions } from './simulate.ts';
import type { Adversary, AdversaryContext } from './adversary.ts';
import { assertInvalid, dealOf, randomHex, seatWith } from './cheatkit.ts';
import { assertAgreement } from './simkit.ts';
import { allowListViolations } from './oracle.ts';

const ROLES = ['MERLIN', 'PERCIVAL', 'MORGANA'];
const base = (seed: number, strategy: SimOptions['strategy'] = 'random'): SimOptions => ({ n: 5, roles: ROLES, seed, strategy });

function revealEnv(ctx: AdversaryContext, view: GameEval, basis: string[]): unknown {
  return {
    v: 1, type: 'reveal', lobby: ctx.lobbyId, game: ctx.config.gameId, step: 'reveal', author: ctx.signer.pub, prev: view.head, t: SIM_T,
    body: { x: encScalar(secretKey(ctx.config, ctx.secrets)), ballots: [], basis },
  };
}

function cancelEnv(ctx: AdversaryContext, at: string, prev: string): unknown {
  return {
    v: 1, type: 'cancel', lobby: ctx.lobbyId, game: ctx.config.gameId, step: 'cancel', author: ctx.signer.pub, prev, t: SIM_T,
    body: { at, reason: 'cancel' },
  };
}

/** Acts once, at the first evaluation for which `when` holds. */
function once(seat: number, when: (v: GameEval) => boolean, act: (v: GameEval, ctx: AdversaryContext) => void): Adversary & { fired: boolean } {
  const a = {
    seat, fired: false,
    rewrite: () => null,
    onEval: (view: GameEval, ctx: AdversaryContext) => {
      if (a.fired || !when(view)) return;
      a.fired = true;
      act(view, ctx);
    },
  };
  return a;
}

test('premature x_j reveal during the game: INVALID(revealed key during the game), the revealer\'s team forfeits', async () => {
  const adv = once(3, (v) => v.pending?.step.id === 'vc/1/0', (v, ctx) => ctx.publish(revealEnv(ctx, v, [])));
  const r = await simulate({ ...base(301), adversary: adv });
  assert.ok(adv.fired);
  const out = assertInvalid(r, 3, 'revealed key during the game', { atStep: 'vc/1/0' });
  assert.equal(out.final, true);
  // §5.11: the honest seats published no multiple of their key outside the allow-list.
  assert.deepEqual(allowListViolations(r, [3]), []);
});

test('premature reveal with a bogus basis: the game is suspended (not continued) until a player cancels', async () => {
  const adv = once(2, (v) => v.pending?.step.id === 'vc/1/0', (v, ctx) => ctx.publish(revealEnv(ctx, v, [randomHex('bogus basis')])));
  let suspendedSeen = false;
  let scheduled = false;
  const r = await simulate({
    ...base(302), adversary: adv,
    onEval: (seat, ev, sim) => {
      if (seat !== 0 || ev.pendingReveals.length === 0) return;
      suspendedSeen = true;
      if (scheduled) return;
      scheduled = true;
      sim.transport.schedule(5000, () => { sim.drivers[0].cancel('cancel').catch(() => undefined); });
    },
  });
  assert.ok(adv.fired && suspendedSeen);
  for (const j of [0, 1, 3, 4]) {
    assert.ok(!(r.seats[j].ev?.chain ?? []).some((c) => c.stepId === 'vc/1/0'), `seat ${j} continued past the suspension`);
    assert.ok(![...r.seats[j].published.keys()].some((k) => k === 'vr/1/0' || k.startsWith('mv/1')), `seat ${j} kept playing`);
  }
  const out = assertAgreement(r, [0, 1, 3, 4]);
  assert.equal(out.state, 'CANCELED');
  assert.match(out.message, new RegExp(`^Canceled by ${r.config.seats[0].name}`));
});

test('sore-loser cancel referencing an old digest after the result is known: INVALID(canceled and continued)', async () => {
  const adv = once(1, (v) => v.terminal?.kind === 'natural', (v, ctx) => {
    const k = v.chain.findIndex((c) => c.stepId === 'p/1/0');
    ctx.publish(cancelEnv(ctx, 'p/1/0', v.chain[k - 1].digest));
  });
  const r = await simulate({ ...base(303, 'good-wins'), adversary: adv });
  assert.ok(adv.fired);
  assertInvalid(r, 1, 'canceled and continued', { atStep: 'p/1/0' });
});

test('cancel during the assassination is ignored; the assassination that follows decides', async () => {
  const o = base(304, 'good-wins');
  const assassin = seatWith(dealOf(o), (l) => l.assassin);
  const adv = once(assassin, (v) => v.pending?.step.id === 'as', (v, ctx) => ctx.publish(cancelEnv(ctx, 'as', v.head)));
  const r = await simulate({ ...o, adversary: adv });
  assert.ok(adv.fired);
  const out = assertAgreement(r);
  assert.equal(r.ev?.terminal?.kind, 'natural');
  assert.equal(out.state, 'GOOD_WIN');
  assert.equal(out.message, 'Three successful missions');
  assert.deepEqual(out.cheaters, []);
});

test('cancel at the final mt/m after the assassination by a tally contributor: INVALID, the other team wins', async () => {
  // A good X after "Merlin assassinated", and an evil non-assassin X after a missed assassination.
  for (const [strategy, pick, expected] of [
    ['merlin-dies', (l: { role: string; assassin: boolean }) => l.role === 'PERCIVAL', 'EVIL_WIN'],
    ['good-wins', (l: { role: string; assassin: boolean }) => l.role === 'MORGANA' && !l.assassin, 'GOOD_WIN'],
  ] as const) {
    const o = base(305, strategy);
    const X = seatWith(dealOf(o), pick);
    const adv = once(X, (v) => v.terminal?.kind === 'natural', (v, ctx) => {
      const k = v.chain.length - 2;
      assert.match(v.chain[k].stepId, /^mt\//);
      ctx.publish(cancelEnv(ctx, v.chain[k].stepId, v.chain[k - 1].digest));
    });
    const r = await simulate({ ...o, adversary: adv });
    assert.ok(adv.fired);
    const out = assertInvalid(r, X, 'canceled and continued');
    assert.equal(out.state, expected);
    assert.equal(out.message, `${r.config.seats[X].name} cheated (canceled and continued); ${teamOf(out.roles[X].role)} forfeits`);
  }
});

test('withholding the last tally share then canceling: attributed, and the decided result restored (rule 5a)', async () => {
  const o: SimOptions = { n: 5, roles: [], seed: 306, strategy: 'evil-wins' };
  const W = 2;
  const adv: Adversary & { fired: boolean } = {
    seat: W, fired: false,
    rewrite: (env) => (env.type === 'tally' && env.step === 'mt/2' ? [] : null),
    onEval: (view, ctx) => {
      if (adv.fired || view.pending?.step.id !== 'mt/2') return;
      adv.fired = true;
      ctx.publish(cancelEnv(ctx, 'mt/2', view.head));
    },
  };
  const r = await simulate({ ...o, adversary: adv });
  assert.ok(adv.fired);
  const honest = [0, 1, 3, 4];
  for (const j of honest) {
    const t = r.seats[j].ev?.terminal;
    assert.equal(t?.kind, 'canceled');
    assert.equal(t?.by, W);
    assert.equal(t?.cancel?.withholding, true);
  }
  const out = assertAgreement(r, honest);
  assert.equal(out.state, 'EVIL_WIN');
  assert.equal(out.message, `Three failed missions (${r.config.seats[W].name} withheld the tally)`);
  assert.equal(out.canceledBy, r.config.seats[W].name);
  assert.deepEqual(out.stalled, [r.config.seats[W].name]);
});
