/**
 * Cheating during setup (docs/p2p-protocol.md §10, §12): bad shuffles, deck
 * equivocation by the last shuffler, identity points, wrong dealing shares,
 * lying in the sight exchange, replayed keys. Each must end INVALID with the
 * exact attribution, and no honest seat may release a secret on a second branch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b64uEncode } from '../crypto/bytes.ts';
import { dct, ect, ept } from '../protocol/machine.ts';
import { otChoice, otSenderMessages } from '../crypto/ot.ts';
import { proveShuffle } from '../crypto/shuffle.ts';
import { proveSigma } from '../crypto/sigma.ts';
import { otEqStatement, otProfileStatement, otRecvStatement, pokStatement } from '../crypto/statements.ts';
import { G, mul } from '../crypto/group.ts';
import { beaconSeed, otBeta } from '../protocol/private.ts';
import type { Bodies, Envelope } from '../protocol/types.ts';
import { simulate, SIM_T, type SimOptions } from './simulate.ts';
import type { Adversary, AdversaryContext } from './adversary.ts';
import {
  assertInvalid, assertSingleBranch, honestSeats, bumpPoint, bumpScalar, copy, dealOf, forge, info, own, pctx, randomHex, seatWith, xOf,
} from './cheatkit.ts';
import { dpt } from '../protocol/machine.ts';

const ROLES = ['MERLIN', 'PERCIVAL', 'MORGANA'];
const opts = (seed: number, adversary?: Adversary, extra?: Partial<SimOptions>): SimOptions => ({ n: 5, roles: ROLES, seed, strategy: 'random', adversary, ...extra });

/** An adversary that rewrites its messages of one type. */
function rewriting(seat: number, type: Envelope['type'], f: (env: Envelope, view: Parameters<Adversary['rewrite']>[1], ctx: AdversaryContext) => Envelope[] | null): Adversary {
  let ctx: AdversaryContext | null = null;
  return {
    seat,
    init: (c) => { ctx = c; },
    rewrite: (env, view) => (env.type === type && ctx !== null ? f(env, view, ctx) : null),
  };
}

function shuffleBody(env: Envelope): Bodies['shuffle'] {
  return env.body as Bodies['shuffle'];
}

test('shuffle with a duplicated card: INVALID(invalid shuffle proof); nothing secret released', async () => {
  const adv = rewriting(2, 'shuffle', (env) => {
    const e = copy(env);
    shuffleBody(e).deck[1] = shuffleBody(e).deck[0];
    return [e];
  });
  const r = await simulate(opts(101, adv));
  assertInvalid(r, 2, 'invalid shuffle proof', { atStep: 'shuf/2' });
  for (const j of honestSeats(r, 2)) assert.ok(!r.seats[j].published.has('deal'), `seat ${j} dealt`);
});

test('shuffle with a replaced card: INVALID(invalid shuffle proof)', async () => {
  const adv = rewriting(1, 'shuffle', (env) => {
    const e = copy(env);
    shuffleBody(e).deck[0].b = bumpPoint(shuffleBody(e).deck[0].b);
    return [e];
  });
  const r = await simulate(opts(102, adv));
  assertInvalid(r, 1, 'invalid shuffle proof', { atStep: 'shuf/1' });
  for (const j of honestSeats(r, 1)) assert.ok(!r.seats[j].published.has('deal'));
});

test('shuffle with a dropped card: INVALID (wrong deck size); with n = 5 the envelope is not even ingestible', async () => {
  const adv = rewriting(3, 'shuffle', (env) => {
    const e = copy(env);
    const b = shuffleBody(e);
    b.deck = b.deck.slice(1);
    b.c = b.c.slice(1);
    b.chat = b.chat.slice(1);
    return [e];
  });
  const r = await simulate({ ...opts(103, adv), n: 6 });
  assertInvalid(r, 3, /^invalid shuffle: deck: expected 6 entries/, { atStep: 'shuf/3' });
  // n = 5: a 4-card deck violates the schema, every peer drops it, the seat stalls; the admin aborts.
  const r5 = await simulate(opts(104, adv, { cancelAt: [{ seat: 0, step: 'shuf/3', reason: 'abort', after: 3000 }] }));
  const out = r5.seats[0].outcome;
  assert.equal(out?.state, 'CANCELED');
  assert.equal(out?.message, `${r5.config.seats[0].name} aborted the start, waiting for ${r5.config.seats[3].name}`);
  assert.deepEqual(out?.cheaters, []);
});

test('invalid shuffle proof: INVALID(invalid shuffle proof)', async () => {
  const adv = rewriting(0, 'shuffle', (env) => {
    const e = copy(env);
    shuffleBody(e).proof.e[0] = bumpScalar(shuffleBody(e).proof.e[0]);
    return [e];
  });
  const r = await simulate(opts(105, adv));
  assertInvalid(r, 0, 'invalid shuffle proof', { atStep: 'shuf/0' });
});

test('identity A in a shuffled deck: INVALID', async () => {
  const adv = rewriting(4, 'shuffle', (env) => {
    const e = copy(env);
    shuffleBody(e).deck[2].a = b64uEncode(new Uint8Array(32));
    return [e];
  });
  const r = await simulate(opts(106, adv));
  assertInvalid(r, 4, /identity/, { atStep: 'shuf/4' });
  for (const j of honestSeats(r, 4)) assert.ok(!r.seats[j].published.has('deal'));
});

test('last shuffler equivocating its deck after collecting shares: INVALID(equivocation); shares exist for one deck only', async () => {
  let done = false;
  const adv: Adversary = {
    seat: 4,
    rewrite: () => null,
    onEval: (view, ctx) => {
      const k = view.chain.findIndex((c) => c.stepId === 'shuf/4');
      if (done || k < 0 || !view.chain.some((c) => c.stepId === 'deal')) return;
      done = true;
      const s = view.state;
      const out = proveShuffle(pctx(ctx, 'shuf/4'), dpt(s.Y as string), s.decks[3].map(dct), { gameSeed: new Uint8Array(32).fill(7), gameId: ctx.config.gameId });
      ctx.publish({
        v: 1, type: 'shuffle', lobby: ctx.lobbyId, game: ctx.config.gameId, step: 'shuf/4', author: ctx.signer.pub,
        prev: view.chain[k - 1].digest, t: SIM_T,
        body: { deck: out.deck.map(ect), c: out.c.map(ept), chat: out.chat.map(ept), proof: out.proof },
      });
    },
  };
  const r = await simulate(opts(107, adv));
  assert.ok(done);
  assertInvalid(r, 4, 'equivocation', { atStep: 'shuf/4' });
  assertSingleBranch(r, 4);
  const deals = r.seats.filter((s) => s.published.has('deal')).length;
  assert.ok(deals >= 4, 'the honest seats dealt before the second deck appeared');
});

test('wrong dealing share: INVALID(invalid deal proof); nobody proceeds to the sight exchange', async () => {
  const adv = rewriting(2, 'deal', (env) => {
    const e = copy(env);
    const b = e.body as Bodies['deal'];
    b.d[0] = bumpPoint(b.d[0] as string);
    return [e];
  });
  const r = await simulate(opts(108, adv));
  assertInvalid(r, 2, 'invalid deal proof', { atStep: 'deal' });
  for (const j of honestSeats(r, 2)) assert.ok(!r.seats[j].published.has('otR'));
});

test('a Loyal Follower choosing Merlin\'s OT index: the honest prover refuses, a forged proof is INVALID', async () => {
  const o = opts(109);
  const lf = seatWith(dealOf(o), (l) => l.role === 'LOYAL FOLLOWER');
  const adv = rewriting(lf, 'ot.recv', (env, view, ctx) => {
    const I = info(ctx);
    const merlinIdx = I.roleNames.indexOf('MERLIN');
    const beta = otBeta(ctx.config, ctx.secrets);
    const U = otChoice(beta, merlinIdx);
    const { A, C, y } = own(view, lf);
    const st = otRecvStatement(pctx(ctx, 'otR'), y, A, C, U, I.labelPts, I.labelRoleIdx);
    const proof = forge(st, I.labels.findIndex((l) => l.role === 'MERLIN'), [xOf(ctx), beta], ctx.seed);
    return [{ ...copy(env), body: { U: ept(U), proof } } as Envelope];
  });
  const r = await simulate({ ...o, adversary: adv });
  assertInvalid(r, lf, 'invalid ot-recv proof', { atStep: 'otR' });
  for (const j of honestSeats(r, lf)) assert.ok(!r.seats[j].published.has('otS'));
});

/** Honest sender material of seat `seat` with profile bits possibly changed. */
function sender(view: Parameters<Adversary['rewrite']>[1], ctx: AdversaryContext, seat: number, bits?: (0 | 1)[]) {
  const I = info(ctx);
  const label = I.labels.findIndex((l) => l.role === 'MORGANA');
  const honestBits = I.seenRows[label];
  const U = (view.state.U as string[]).map((u, Q) => (Q === seat ? null : dpt(u)));
  const m = otSenderMessages(ctx.seed, bits ?? honestBits, U, seat);
  return { I, label, honestBits, U, ...m };
}

function otSendEnv(env: Envelope, ctx: AdversaryContext, F: ReturnType<typeof sender>['F'], E: ReturnType<typeof sender>['E'], profile: Bodies['ot.send']['profile'], eq: Bodies['ot.send']['eq']): Envelope {
  return {
    ...copy(env),
    body: { F: F.map(ect), E: E.map((row) => (row === null ? null : row.map(ect))), profile, eq, seed: b64uEncode(beaconSeed(ctx.config, ctx.secrets)) },
  } as Envelope;
}

test('OT sender lying (Morgana hiding from Merlin): INVALID(invalid ot-send proof)', async () => {
  const o = opts(110);
  const morgana = seatWith(dealOf(o), (l) => l.role === 'MORGANA');
  const adv = rewriting(morgana, 'ot.send', (env, view, ctx) => {
    const h = sender(view, ctx, morgana);
    const bits = [...h.honestBits];
    bits[h.I.roleNames.indexOf('MERLIN')] = 0;
    const s = sender(view, ctx, morgana, bits);
    const { A, C, y } = own(view, morgana);
    const pc = pctx(ctx, 'otS');
    const profile = forge(otProfileStatement(pc, y, A, C, s.F, s.I.labelPts, s.I.seenRows), s.label, [xOf(ctx), ...s.f], ctx.seed);
    const k = s.k.flatMap((row) => row ?? []);
    const eq = proveSigma(otEqStatement(pc, s.F, s.E, s.U, morgana), 0, [...s.f, ...k], ctx.seed);
    return [otSendEnv(env, ctx, s.F, s.E, profile, eq)];
  });
  const r = await simulate({ ...o, adversary: adv });
  assertInvalid(r, morgana, 'invalid ot-send proof', { atStep: 'otS' });
});

test('OT sender tagging one receiver (different bits for one seat): INVALID(invalid ot-send proof)', async () => {
  const o = opts(111);
  const labels = dealOf(o);
  const morgana = seatWith(labels, (l) => l.role === 'MORGANA');
  const merlin = seatWith(labels, (l) => l.role === 'MERLIN');
  const adv = rewriting(morgana, 'ot.send', (env, view, ctx) => {
    const h = sender(view, ctx, morgana);
    const flipped = h.honestBits.map((b): 0 | 1 => (b === 1 ? 0 : 1));
    const alt = sender(view, ctx, morgana, flipped);
    const E = h.E.map((row, Q) => (Q === merlin ? alt.E[Q] : row));
    const { A, C, y } = own(view, morgana);
    const pc = pctx(ctx, 'otS');
    const profile = proveSigma(otProfileStatement(pc, y, A, C, h.F, h.I.labelPts, h.I.seenRows), h.label, [xOf(ctx), ...h.f], ctx.seed);
    const eq = forge(otEqStatement(pc, h.F, E, h.U, morgana), 0, [...h.f, ...h.k.flatMap((row) => row ?? [])], ctx.seed);
    return [otSendEnv(env, ctx, h.F, E, profile, eq)];
  });
  const r = await simulate({ ...o, adversary: adv });
  assertInvalid(r, morgana, 'invalid ot-send proof', { atStep: 'otS' });
});

test('OT sender corrupting one index (selective failure): INVALID(invalid ot-send proof)', async () => {
  const adv = rewriting(3, 'ot.send', (env) => {
    const e = copy(env);
    const b = e.body as Bodies['ot.send'];
    const row = b.E[0] ?? b.E[1];
    assert.ok(row !== null);
    row[0].b = bumpPoint(row[0].b);
    return [e];
  });
  const r = await simulate(opts(112, adv));
  assertInvalid(r, 3, 'invalid ot-send proof', { atStep: 'otS' });
});

test('replayed key: from another game it is absent (stall, abort); re-anchored it is INVALID(invalid key proof)', async () => {
  const other = randomHex('another game config');
  const replay = (reanchor: boolean): Adversary => rewriting(1, 'key', (env, _view, ctx) => {
    const x = xOf(ctx);
    const y = mul(G, x);
    const pok = proveSigma(pokStatement({ configId: other, stepId: 'key', prover: ctx.signer.pub }, y), 0, [x], ctx.seed);
    const e = copy(env);
    (e.body as Bodies['key']).pok = pok;
    return [reanchor ? e : { ...e, prev: other }];
  });
  const r1 = await simulate(opts(113, replay(false), { cancelAt: [{ seat: 0, step: 'key', reason: 'abort', after: 3000 }] }));
  const out = r1.seats[0].outcome;
  assert.equal(out?.state, 'CANCELED');
  assert.equal(out?.message, `${r1.config.seats[0].name} aborted the start, waiting for ${r1.config.seats[1].name}`);
  assert.deepEqual(out?.cheaters, []);
  const r2 = await simulate(opts(114, replay(true)));
  assertInvalid(r2, 1, 'invalid key proof', { atStep: 'key' });
  // A copy of another seat's key (rogue/copied key) fails the same way.
  let copied = false;
  const copier: Adversary = {
    seat: 2,
    rewrite: (env) => (env.type === 'key' ? [] : null),
    onEval: (_view, ctx) => {
      const victim = ctx.drivers()[0].messages().find((m) => m.env.type === 'key' && m.env.author === ctx.config.seats[0].pub);
      if (copied || victim === undefined) return;
      copied = true;
      ctx.publish({ ...copy(victim.env), author: ctx.signer.pub });
    },
  };
  const r3 = await simulate(opts(115, copier));
  assert.ok(copied);
  assertInvalid(r3, 2, 'invalid key proof', { atStep: 'key' });
});
