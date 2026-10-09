/**
 * Non-interference (docs/p2p-protocol.md §9, §12):
 *  1. Two games whose deals are indistinguishable to seat s (same label, same
 *     sight bits) with the same public choices give s identical projectGame and
 *     projectRole at every evaluation until the outcome is terminal.
 *  2. For a seat whose role differs between two runs, the souls it subscribes to
 *     and the kinds and sizes of the jobs its driver runs are identical.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CardLabel } from '../crypto/types.ts';
import { seen } from '../protocol/rules.ts';
import type { GameSecrets } from '../protocol/private.ts';
import { memoCrypto, simConfig, simGameSeed, simulate, type ScriptedStrategy, type SimResult } from './simulate.ts';
import { predictDeal } from './predict.ts';
import type { Hex32, Verdict } from '../protocol/types.ts';

const N = 6;
const ROLES = ['MERLIN', 'PERCIVAL', 'MORGANA', 'ASSASSIN'];
const SEED = 41;
const S = 2;

/** Role-independent public choices: consecutive teams, everyone approves and succeeds, the assassin targets seat S. */
const SCRIPT: ScriptedStrategy = {
  propose: (c) => {
    const cur = c.ev.state.cursor;
    const size = cur.t === 'p' ? c.ev.state.missions[cur.m].teamSize : 0;
    return Array.from({ length: size }, (_, i) => (c.seat + i) % N);
  },
  vote: () => true,
  mission: () => true,
  assassinate: () => S,
};

function sightBits(labels: CardLabel[], s: number): boolean[] {
  return labels.map((l, j) => j !== s && seen(labels[s].role, l.role));
}

interface Candidate { seeds: Uint8Array[]; labels: CardLabel[]; fp: number }

function search(): { a: Candidate; b: Candidate; c: Candidate } {
  const { config, configMsg } = simConfig(N, ROLES, SEED);
  const cands: Candidate[] = [];
  for (let attempt = 0; attempt < 400; attempt++) {
    const seeds = Array.from({ length: N }, (_, j) => simGameSeed(SEED, j, attempt));
    const secrets: GameSecrets[] = seeds.map((gameSeed) => ({ gameSeed }));
    const d = predictDeal(config, configMsg.msgId, secrets);
    cands.push({ seeds, labels: d.labels, fp: d.firstProposer });
    const lf = cands.filter((x) => x.labels[S].role === 'LOYAL FOLLOWER' && !x.labels[S].assassin);
    for (const a of lf) {
      const b = lf.find((x) => x !== a && x.fp === a.fp && JSON.stringify(x.labels) !== JSON.stringify(a.labels)
        && JSON.stringify(sightBits(x.labels, S)) === JSON.stringify(sightBits(a.labels, S)));
      const c = cands.find((x) => x.fp === a.fp && x.labels[S].role === 'MERLIN');
      if (b !== undefined && c !== undefined) return { a, b, c };
    }
  }
  throw new Error('no suitable deals found');
}

interface Recording { views: string[]; jobs: string[]; souls: string[]; r: SimResult }

async function run(c: Candidate): Promise<Recording> {
  const views: string[] = [];
  const jobs: string[] = [];
  const memo = new Map<Hex32, Verdict>();
  const r = await simulate({
    n: N, roles: ROLES, seed: SEED, strategy: SCRIPT, gameSeeds: c.seeds,
    // The log bundle is written after the end and carries the (public, run-specific) outcome: compared by kind.
    crypto: (seat) => memoCrypto(memo, seat === S ? (kind, size) => jobs.push(kind === 'prove:log' ? kind : `${kind} ${size}`) : undefined),
    onView: (seat, v) => {
      if (seat !== S || v.terminal) return;
      const j = JSON.stringify({ game: v.game, role: v.role });
      if (views[views.length - 1] !== j) views.push(j);
    },
  });
  return { views, jobs, souls: [...r.peers[S].subscribed], r };
}

test('non-interference: projections, subscriptions and job sequences do not depend on hidden roles', async () => {
  const { a, b, c } = search();
  assert.equal(a.labels[S].role, 'LOYAL FOLLOWER');
  assert.equal(c.labels[S].role, 'MERLIN');
  assert.notDeepEqual(a.labels, b.labels);
  const ra = await run(a);
  const rb = await run(b);
  const rc = await run(c);
  for (const x of [ra, rb, rc]) {
    assert.deepEqual(x.r.errors, []);
    assert.ok(x.r.outcome !== null);
  }
  // The deals really are the predicted ones.
  assert.deepEqual(ra.r.labels, a.labels);
  assert.deepEqual(rc.r.labels, c.labels);
  // 1. Indistinguishable deals for S: identical views until the outcome is terminal.
  assert.ok(ra.views.length > 20);
  assert.deepEqual(rb.views, ra.views);
  // 2. S's role differs (LF vs MERLIN): identical souls and job kinds/sizes.
  assert.deepEqual(rc.souls, ra.souls);
  assert.deepEqual(ra.souls.slice(0, 2), [`avalon/v1/game/${ra.r.config.gameId}/setup#`, `avalon/v1/game/${ra.r.config.gameId}/play#`]);
  assert.ok(ra.jobs.length > 30);
  assert.deepEqual(rc.jobs, ra.jobs);
  // ...while the outcomes differ (S, the assassination target, is Merlin only in run c).
  assert.equal(ra.r.outcome?.state, 'GOOD_WIN');
  assert.equal(rc.r.outcome?.state, 'EVIL_WIN');
});
