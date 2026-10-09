/**
 * Cheating during play (docs/p2p-protocol.md §10, §12): forbidden ballots,
 * equivocation at every human and automatic step, vote reveals that do not
 * open their commit, bad proposals and false assassination claims.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexDecode } from '../crypto/bytes.ts';
import { ballotRandomness } from '../crypto/derive.ts';
import { encryptBit, type Ct } from '../crypto/elgamal.ts';
import { G, mul, mulPub } from '../crypto/group.ts';
import { proveSigma } from '../crypto/sigma.ts';
import { ballotStatement, openStatement } from '../crypto/statements.ts';
import { dpt, ect, ept, finalA, type GameEval } from '../protocol/machine.ts';
import type { Bodies, Envelope } from '../protocol/types.ts';
import { simulate, SIM_T, type SimOptions } from './simulate.ts';
import type { Adversary, AdversaryContext } from './adversary.ts';
import { assertInvalid, copy, dealOf, forge, info, own, pctx, seatWith, twin, xOf } from './cheatkit.ts';
import { assertAgreement } from './simkit.ts';
import { teamOf } from '../protocol/rules.ts';

const ROLES = ['MERLIN', 'PERCIVAL', 'MORGANA'];
const base = (seed: number, strategy: SimOptions['strategy'] = 'random'): SimOptions => ({ n: 5, roles: ROLES, seed, strategy });

function rewriting(seat: number, type: Envelope['type'], f: (env: Envelope, view: GameEval, ctx: AdversaryContext) => Envelope[] | null): Adversary & { steps: string[] } {
  let ctx: AdversaryContext | null = null;
  const steps: string[] = [];
  return {
    seat, steps,
    init: (c) => { ctx = c; },
    rewrite: (env, view) => {
      if (env.type !== type || ctx === null) return null;
      steps.push(env.step);
      return f(env, view, ctx);
    },
  };
}

function goodSeat(o: SimOptions): number {
  return seatWith(dealOf(o), (l) => teamOf(l.role) === 'good');
}

/** A ballot envelope with the given ciphertext and proof. */
function ballotEnv(env: Envelope, ballot: Ct, proof: Bodies['ballot']['proof']): Envelope {
  return { ...copy(env), body: { ballot: ect(ballot), proof } } as Envelope;
}

test('good player failing: the honest prover cannot make the proof; a forged one is INVALID(invalid ballot proof)', async () => {
  const o = base(201, 'good-wins');
  const g = goodSeat(o);
  const adv = rewriting(g, 'ballot', (env, view, ctx) => {
    const I = info(ctx);
    const Y = dpt(view.state.Y as string);
    const r = ballotRandomness(ctx.seed, env.step, hexDecode(env.prev, 32), 1);
    const ballot = encryptBit(Y, 1, r);
    const { A, C, y } = own(view, g);
    const st = ballotStatement(pctx(ctx, env.step), Y, ballot, y, A, C, I.evilLabelPts);
    return [ballotEnv(env, ballot, forge(st, 1, [r, xOf(ctx)], ctx.seed))];
  });
  const r = await simulate({ ...o, adversary: adv });
  assertInvalid(r, g, 'invalid ballot proof', { atStep: adv.steps[0] });
});

test('ballot = another seat\'s card ciphertext (decryption oracle attempt): INVALID(invalid ballot proof)', async () => {
  const o = base(202, 'good-wins');
  const g = goodSeat(o);
  const adv = rewriting(g, 'ballot', (env, view, ctx) => {
    const I = info(ctx);
    const victim = (g + 1) % 5;
    const A = finalA(view.state) as string[];
    const ballot: Ct = { a: dpt(A[victim]), b: dpt((view.state.C as string[])[victim]) };
    const mine = own(view, g);
    const st = ballotStatement(pctx(ctx, env.step), dpt(view.state.Y as string), ballot, mine.y, mine.A, mine.C, I.evilLabelPts);
    return [ballotEnv(env, ballot, forge(st, 0, [xOf(ctx)], ctx.seed))];
  });
  const r = await simulate({ ...o, adversary: adv });
  assertInvalid(r, g, 'invalid ballot proof', { atStep: adv.steps[0] });
});

/** A team member that withholds its own ballot and publishes `make(victimBallot)` once another member's ballot is visible. */
function copier(seat: number, make: (victim: Envelope, view: GameEval) => Bodies['ballot']): Adversary & { done: string[] } {
  const done: string[] = [];
  return {
    seat, done,
    rewrite: (env) => (env.type === 'ballot' ? [] : null),
    onEval: (view, ctx) => {
      const p = view.pending;
      if (p === null || p.step.type !== 'ballot' || p.step.req === 'assassin' || !p.step.req.includes(seat) || done.includes(p.step.id)) return;
      const victim = ctx.driver().messages().find((m) => m.env.type === 'ballot' && m.env.step === p.step.id && m.env.prev === view.head
        && m.env.author !== ctx.signer.pub);
      if (victim === undefined) return;
      done.push(p.step.id);
      ctx.publish({
        v: 1, type: 'ballot', lobby: ctx.lobbyId, game: ctx.config.gameId, step: p.step.id, author: ctx.signer.pub,
        prev: view.head, t: SIM_T, body: make(victim.env, view),
      });
    },
  };
}

test('copied ballot: INVALID(invalid ballot proof) (the proof binds the prover)', async () => {
  const o = base(203, 'good-wins');
  const adv = copier(goodSeat(o), (victim) => copy(victim.body as Bodies['ballot']));
  const r = await simulate({ ...o, adversary: adv });
  assert.ok(adv.done.length > 0);
  assertInvalid(r, adv.seat, 'invalid ballot proof', { atStep: adv.done[0] });
});

test('re-randomized ballot: INVALID(invalid ballot proof) (PoK of r)', async () => {
  const o = base(204, 'good-wins');
  const adv = copier(goodSeat(o), (victim, view) => {
    const b = copy(victim.body as Bodies['ballot']);
    const s = 12345n;
    const Y = dpt(view.state.Y as string);
    b.ballot = { a: ept(dpt(b.ballot.a).add(mulPub(G, s))), b: ept(dpt(b.ballot.b).add(mulPub(Y, s))) };
    return b;
  });
  const r = await simulate({ ...o, adversary: adv });
  assert.ok(adv.done.length > 0);
  assertInvalid(r, adv.seat, 'invalid ballot proof', { atStep: adv.done[0] });
});

test('vote value 2: INVALID(invalid ballot proof)', async () => {
  const o = base(205, 'good-wins');
  const g = goodSeat(o);
  const adv = rewriting(g, 'ballot', (env, view, ctx) => {
    const I = info(ctx);
    const Y = dpt(view.state.Y as string);
    const r = ballotRandomness(ctx.seed, env.step, hexDecode(env.prev, 32), 0);
    const ballot: Ct = { a: mul(G, r), b: G.add(G).add(mul(Y, r)) };
    const { A, C, y } = own(view, g);
    const st = ballotStatement(pctx(ctx, env.step), Y, ballot, y, A, C, I.evilLabelPts);
    return [ballotEnv(env, ballot, forge(st, 0, [r], ctx.seed))];
  });
  const r = await simulate({ ...o, adversary: adv });
  assertInvalid(r, g, 'invalid ballot proof', { atStep: adv.steps[0] });
});

for (const [type, label, strategy] of [
  ['propose', 'proposal', 'random'], ['vote.commit', 'vote commit', 'random'], ['ballot', 'ballot', 'good-wins'],
  ['tally', 'tally share', 'random'], ['vote.reveal', 'vote reveal', 'random'],
] as const) {
  test(`equivocating ${label}: INVALID(equivocation)`, async () => {
    const o = base(210 + label.length, strategy);
    const seat = type === 'ballot' ? goodSeat(o) : 3;
    const adv = rewriting(seat, type, (env) => {
      if (type !== 'propose') return [env, twin(env)];
      const b = env.body as Bodies['propose'];
      const other = [0, 1, 2, 3, 4].find((j) => !b.team.includes(j)) as number;
      const team = [...b.team.slice(1), other].sort((x, y) => x - y);
      return [env, { ...copy(env), body: { team } } as Envelope];
    });
    const r = await simulate({ ...o, adversary: adv });
    assert.ok(adv.steps.length > 0);
    assertInvalid(r, seat, 'equivocation', { atStep: adv.steps[0] });
  });
}

test('equivocating assassination (two targets, both openings valid): INVALID(equivocation)', async () => {
  const o = base(220, 'good-wins');
  const assassin = seatWith(dealOf(o), (l) => l.assassin);
  const adv = rewriting(assassin, 'assassinate', (env) => {
    const b = env.body as Bodies['assassinate'];
    const other = [0, 1, 2, 3, 4].find((j) => j !== assassin && j !== b.target) as number;
    return [env, { ...copy(env), body: { ...copy(b), target: other } } as Envelope];
  });
  const r = await simulate({ ...o, adversary: adv });
  assertInvalid(r, assassin, 'equivocation', { atStep: 'as' });
});

test('vote reveal not matching its commit: INVALID(vote reveal does not match commit)', async () => {
  const adv = rewriting(2, 'vote.reveal', (env) => {
    const e = copy(env);
    const b = e.body as Bodies['vote.reveal'];
    b.approve = !b.approve;
    return [e];
  });
  const r = await simulate({ ...base(221), adversary: adv });
  assertInvalid(r, 2, 'vote reveal does not match commit', { atStep: adv.steps[0] });
});

test('a proposal by a seat that is not the proposer is ignored; the game continues normally', async () => {
  const injected: string[] = [];
  const adv: Adversary = {
    seat: 1,
    rewrite: () => null,
    onEval: (view, ctx) => {
      const p = view.pending;
      if (p === null || p.step.type !== 'propose' || p.step.req === 'assassin' || p.step.req[0] === 1 || injected.includes(p.step.id)) return;
      const cur = view.state.cursor;
      if (cur.t !== 'p') return;
      injected.push(p.step.id);
      const size = view.state.missions[cur.m].teamSize;
      ctx.publish({
        v: 1, type: 'propose', lobby: ctx.lobbyId, game: ctx.config.gameId, step: p.step.id, author: ctx.signer.pub,
        prev: view.head, t: SIM_T, body: { team: Array.from({ length: size }, (_, i) => i) },
      });
    },
  };
  const r = await simulate({ ...base(222, 'good-wins'), adversary: adv });
  assert.ok(injected.length > 0);
  const out = assertAgreement(r);
  assert.deepEqual(out.cheaters, []);
  assert.ok(out.state === 'GOOD_WIN' || out.state === 'EVIL_WIN');
  const onChain = new Set(r.ev?.chain.flatMap((c) => c.msgIds));
  for (const m of r.seats[0].driver.messages()) {
    if (m.env.type === 'propose' && m.env.author === r.config.seats[1].pub && injected.includes(m.env.step)) assert.ok(!onChain.has(m.msgId));
  }
});

test('wrong team size: INVALID(invalid team)', async () => {
  const adv = rewriting(4, 'propose', (env) => {
    const b = env.body as Bodies['propose'];
    const other = [0, 1, 2, 3, 4].find((j) => !b.team.includes(j)) as number;
    return [{ ...copy(env), body: { team: [...b.team, other].sort((x, y) => x - y) } } as Envelope];
  });
  const r = await simulate({ ...base(223), adversary: adv });
  assertInvalid(r, 4, 'invalid team', { atStep: adv.steps[0] });
});

test('duplicate team members: the envelope violates the schema and is dropped; the proposer stalls and is named', async () => {
  const adv = rewriting(2, 'propose', (env) => {
    const b = env.body as Bodies['propose'];
    return [{ ...copy(env), body: { team: [b.team[0], ...b.team.slice(0, -1)] } } as Envelope];
  });
  let scheduled = false;
  const r = await simulate({
    ...base(224), adversary: adv,
    onEval: (seat, ev, sim) => {
      if (scheduled || seat !== 0 || adv.steps.length === 0 || ev.pending?.step.id !== adv.steps[0]) return;
      scheduled = true;
      sim.transport.schedule(3000, () => { sim.drivers[0].cancel('cancel').catch(() => undefined); });
    },
  });
  assert.ok(scheduled);
  const out = assertAgreement(r, [0, 1, 3, 4]);
  assert.equal(out.state, 'CANCELED');
  assert.equal(out.message, `Canceled by ${r.config.seats[0].name}, waiting for ${r.config.seats[2].name}`);
  assert.deepEqual(out.cheaters, []);
});

test('non-assassin claiming the assassination with a valid opening of its own card: INVALID(false assassination claim)', async () => {
  const o = base(225, 'good-wins');
  const morgana = seatWith(dealOf(o), (l) => l.role === 'MORGANA' && !l.assassin);
  let claimed = false;
  const adv: Adversary = {
    seat: morgana,
    rewrite: () => null,
    onEval: (view, ctx) => {
      if (claimed || view.pending?.step.id !== 'as') return;
      claimed = true;
      const { A, y } = own(view, morgana);
      const x = xOf(ctx);
      const Oa = mul(A, x);
      const proof = proveSigma(openStatement(pctx(ctx, 'as'), y, A, Oa), 0, [x], ctx.seed);
      ctx.publish({
        v: 1, type: 'assassinate', lobby: ctx.lobbyId, game: ctx.config.gameId, step: 'as', author: ctx.signer.pub,
        prev: view.head, t: SIM_T, body: { target: (morgana + 1) % 5, open: ept(Oa), proof },
      });
    },
  };
  const r = await simulate({ ...o, adversary: adv });
  assert.ok(claimed);
  const out = assertInvalid(r, morgana, 'false assassination claim', { atStep: 'as' });
  assert.equal(out.state, 'GOOD_WIN');
});
