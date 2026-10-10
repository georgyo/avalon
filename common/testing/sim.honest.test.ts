/**
 * Full honest games (docs/p2p-protocol.md §12, in-process simulations): every
 * n = 5..10, each role-configuration class, ending in every natural outcome.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from './simulate.ts';
import { assertHonestGame } from './simkit.ts';
import { allowListViolations } from './oracle.ts';

const ALL = ['MERLIN', 'PERCIVAL', 'MORGANA', 'MORDRED', 'OBERON', 'ASSASSIN'];

test('n=5, Merlin/Percival/Morgana: assassination missed -> GOOD_WIN', async () => {
  const r = await simulate({ n: 5, roles: ['MERLIN', 'PERCIVAL', 'MORGANA'], seed: 11, strategy: 'good-wins' });
  const out = assertHonestGame(r);
  assert.deepEqual(allowListViolations(r), []);
  assert.equal(out.state, 'GOOD_WIN');
  assert.equal(out.message, 'Three successful missions');
  assert.ok(out.assassinated !== undefined);
  assert.notEqual(out.roles.find((x) => x.name === out.assassinated)?.role, 'MERLIN');
  assert.deepEqual(r.seats[0].view?.game.state, 'ENDED');
});

test('n=6, Merlin/Assassin: Merlin assassinated -> EVIL_WIN', async () => {
  const r = await simulate({ n: 6, roles: ['MERLIN', 'ASSASSIN'], seed: 12, strategy: 'merlin-dies' });
  const out = assertHonestGame(r);
  assert.deepEqual(allowListViolations(r), []);
  assert.equal(out.state, 'EVIL_WIN');
  assert.equal(out.message, 'Merlin assassinated');
  assert.equal(out.roles.find((x) => x.name === out.assassinated)?.role, 'MERLIN');
  assert.ok(out.roles.some((x) => x.role === 'ASSASSIN' && x.assassin));
});

test('n=7, no special roles: three successes without Merlin -> GOOD_WIN', async () => {
  const r = await simulate({ n: 7, roles: [], seed: 13, strategy: 'good-wins' });
  const out = assertHonestGame(r);
  assert.deepEqual(allowListViolations(r), []);
  assert.equal(out.state, 'GOOD_WIN');
  assert.equal(out.message, 'Three missions succeeded');
  assert.equal(out.assassinated, undefined);
});

test('n=8, Percival/Mordred/Oberon: three failed missions -> EVIL_WIN (mission 4 needs two fails)', async () => {
  const r = await simulate({ n: 8, roles: ['PERCIVAL', 'MORDRED', 'OBERON'], seed: 14, strategy: 'evil-wins' });
  const out = assertHonestGame(r);
  assert.equal(out.state, 'EVIL_WIN');
  assert.equal(out.message, 'Three failed missions');
});

test('n=9, every role: five rejected proposals -> EVIL_WIN', async () => {
  const r = await simulate({ n: 9, roles: ALL, seed: 15, strategy: 'reject' });
  const out = assertHonestGame(r);
  assert.equal(out.state, 'EVIL_WIN');
  assert.equal(out.message, 'Five team proposals in a row rejected');
  assert.deepEqual(out.votes, []);
  const m0 = r.seats[0].view?.game.missions[0];
  assert.equal(m0?.proposals.length, 5);
  assert.ok(m0?.proposals.every((p) => p.state === 'REJECTED' && p.votes.length === 0));
});

test('n=10, every role: random play', async () => {
  const r = await simulate({ n: 10, roles: ALL, seed: 16, strategy: 'random' });
  const out = assertHonestGame(r);
  assert.ok(out.state === 'GOOD_WIN' || out.state === 'EVIL_WIN');
});
