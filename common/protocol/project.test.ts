/**
 * Projections (docs/p2p-protocol.md §11.3): GameData during setup, proposal
 * votes, mission votes and after the end; SetupProgress; RoleDoc.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOutcome } from './outcome.ts';
import { projectGame, projectProgress, projectRole } from './project.ts';
import { before, evalFull, recordGame, stepMsgs, withMsgs } from '../testing/transcript.ts';

test('projectGame / projectProgress / projectRole through a game', async () => {
  const R = await recordGame({ n: 5, roles: ['MERLIN', 'PERCIVAL', 'MORGANA'], seed: 61, strategy: 'good-wins' });
  const { config, configId } = R.t;
  const names = config.seats.map((s) => s.name);
  const proj = (msgs: Parameters<typeof evalFull>[2]) => {
    const ev = evalFull(config, configId, msgs);
    return { ev, game: projectGame(config, ev, computeOutcome(config, ev, msgs)), progress: projectProgress(config, ev) };
  };

  // Setup: keys 2/5.
  const keys = stepMsgs(R, 'key');
  let p = proj(new Map([0, 3].map((j) => [(keys.get(j))!.msgId, keys.get(j)!])));
  assert.equal(p.game.state, 'INIT');
  assert.equal(p.game.phase, '');
  assert.deepEqual(p.game.setup, { stage: 'keys', done: 2, total: 5, waitingFor: [names[1], names[2], names[4]] });
  assert.deepEqual(p.game.roles, ['MORGANA', 'EVIL MINION', 'MERLIN', 'PERCIVAL', 'LOYAL FOLLOWER']);
  p = proj(before(R, 'shuf/2'));
  assert.deepEqual(p.progress, { stage: 'shuffle', done: 2, total: 5, waitingFor: [names[2]] });
  p = proj(before(R, 'otS'));
  assert.equal(p.progress?.stage, 'sight');

  // Proposal vote: commits fill `votes` (seat order) while pending; approvers afterwards.
  const vc = stepMsgs(R, 'vc/0/0');
  p = proj(withMsgs(before(R, 'vc/0/0'), vc.get(3)!, vc.get(1)!));
  assert.equal(p.game.state, 'ACTIVE');
  assert.equal(p.game.phase, 'PROPOSAL_VOTE');
  const prop = p.game.missions[0].proposals[0];
  assert.deepEqual(prop.votes, [names[1], names[3]]);
  assert.equal(prop.state, 'PENDING');
  assert.equal(prop.team.length, 2);
  assert.equal(p.game.setup, undefined);
  p = proj(before(R, 'mv/0'));
  assert.equal(p.game.phase, 'MISSION_VOTE');
  assert.equal(p.game.missions[0].proposals[0].state, 'APPROVED');
  assert.deepEqual(p.game.missions[0].proposals[0].votes, names);
  assert.deepEqual(p.game.missions[0].team, []);

  // Mission vote: voters fill `team` while pending; the proposal's team afterwards.
  const mv = stepMsgs(R, 'mv/0');
  const [firstVoter] = [...mv.keys()];
  p = proj(withMsgs(before(R, 'mv/0'), mv.get(firstVoter)!));
  assert.deepEqual(p.game.missions[0].team, [names[firstVoter]]);
  p = proj(before(R, 'p/1/0'));
  assert.equal(p.game.phase, 'TEAM_PROPOSAL');
  assert.equal(p.game.missions[0].state, 'SUCCESS');
  assert.equal(p.game.missions[0].numFails, 0);
  assert.deepEqual(p.game.missions[0].team, p.game.missions[0].proposals[0].team);
  assert.equal(p.game.missions[1].proposals.length, 1);
  assert.deepEqual(p.game.missions[1].proposals[0].team, []);

  // End.
  p = proj(R.msgs);
  assert.equal(p.game.state, 'ENDED');
  assert.equal(p.game.phase, 'ASSASSINATION');
  assert.equal(p.game.outcome?.state, 'GOOD_WIN');
  assert.equal(p.progress, null);

  // RoleDoc: role object, assassin flag, sees once known.
  const seat = R.r.labels.findIndex((l) => l?.role === 'MERLIN');
  const doc = projectRole(config, { seat, label: { role: 'MERLIN', assassin: false }, seesSeats: [0, 4], c: 0, sightKnown: true });
  assert.equal(doc?.role.name, 'MERLIN');
  assert.equal(doc?.role.team, 'good');
  assert.equal(doc?.assassin, false);
  assert.deepEqual(doc?.sees, [names[0], names[4]]);
  assert.equal(projectRole(config, { seat, label: { role: 'MERLIN', assassin: false }, seesSeats: [], c: 0, sightKnown: false })?.sees, undefined);
  assert.equal(projectRole(config, null), null);
});
