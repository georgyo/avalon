/** Completeness sweep, shard 0 of 2, coverage checks and the slow full sweep (see sweepkit.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES } from '../avalonlib.ts';
import { allDecks, roleNamesInPlay } from './testkit.ts';
import { SLOW, lambdaDecks, runFullSweep, runLambdaShard } from './sweepkit.ts';

test('sweep coverage: 332 decks, 116 label lists, R = 2..7, the role combinations the sample decks miss', () => {
  const decks = allDecks();
  assert.equal(decks.length, 332);
  const lds = lambdaDecks();
  assert.equal(lds.length, 116);
  const has = (ls: { role: string; assassin: boolean }[], role: string, assassin?: boolean): boolean =>
    ls.some((l) => l.role === role && (assassin === undefined || l.assassin === assassin));
  assert.deepEqual([...new Set(lds.map((d) => roleNamesInPlay(d.labels).length))].sort(), [2, 3, 4, 5, 6, 7]);
  assert.ok(lds.some((d) => has(d.labels, 'ASSASSIN', false) && !has(d.labels, 'MERLIN')), 'ASSASSIN without MERLIN');
  assert.ok(lds.some((d) => d.labels.filter((l) => l.role === 'EVIL MINION').length >= 2 && has(d.labels, 'EVIL MINION', true)));
  assert.ok(lds.some((d) => d.labels.filter((l) => l.role === 'EVIL MINION').length >= 2 && !d.labels.some((l) => l.assassin)));
  assert.ok(lds.some((d) => !has(d.labels, 'PERCIVAL') && !has(d.labels, 'MORGANA')));
  // every evil role but OBERON carries the assassin flag in some deck (OBERON has the lowest
  // assassinationPriority and every evil team has at least two cards, so it never does)
  for (const r of ROLES.filter((x) => x.team === 'evil')) {
    assert.equal(lds.some((d) => has(d.labels, r.name, true)), r.name !== 'OBERON', r.name);
  }
});

test('completeness sweep, shard 0/2: every distinct label list Λ', () => {
  assert.equal(runLambdaShard(0, 2), 58);
});

test('completeness sweep (slow): all 332 decks, proven shuffle and dealing, every sender and ballot', { skip: !SLOW }, () => {
  runFullSweep();
});
