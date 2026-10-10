/**
 * Non-interference (docs/p2p-protocol.md §9, §12):
 *  1. Two games whose deals are indistinguishable to seat s (same label, same
 *     sight bits) with the same public choices give s identical projectGame and
 *     projectRole at every evaluation until the outcome is terminal.
 *  2. For a seat whose role differs between two runs, the souls it subscribes to
 *     and the kinds and sizes of the jobs its driver runs are identical.
 *  3. Metadata (§9): for every seat, the job sequence, and the relay's whole
 *     publication log (virtual time, publishing peer, type, step, value
 *     length, re-puts) are identical across the three runs (whose deals all
 *     differ) until the assassination.
 *  4. The decryption allow-list (§5.11) holds for every seat in every run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CardLabel } from '../crypto/types.ts';
import { seen } from '../protocol/rules.ts';
import type { GameSecrets } from '../protocol/private.ts';
import { memoCrypto, simConfig, simGameSeed, simulate, type ScriptedStrategy, type SimResult } from './simulate.ts';
import { predictDeal } from './predict.ts';
import { allowListViolations } from './oracle.ts';
import { decodeEnvelope } from '../protocol/envelope.ts';
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

interface Recording { views: string[]; jobs: string[]; allJobs: string[][]; pubs: string[]; souls: string[]; r: SimResult }

/** Up to the assassination: the assassin's own prove, the verification of its opening, any reveal or log. */
const END_JOB = /^(prove:(assassinate|reveal|log)|verify open:)/;

async function run(c: Candidate): Promise<Recording> {
  const views: string[] = [];
  const allJobs: string[][] = Array.from({ length: N }, () => []);
  const pubs: string[] = [];
  const memo = new Map<Hex32, Verdict>();
  let ended = false;
  const r = await simulate({
    n: N, roles: ROLES, seed: SEED, strategy: SCRIPT, gameSeeds: c.seeds,
    // The log bundle is written after the end and carries the (public, run-specific) outcome: compared by kind.
    crypto: (seat) => memoCrypto(memo, (kind, size) => allJobs[seat].push(kind === 'prove:log' ? kind : `${kind} ${size}`)),
    onTransport: (t) => {
      t.onPublish = (e) => {
        const d = decodeEnvelope(e.value, e.key);
        if ('error' in d || ['assassinate', 'reveal', 'log'].includes(d.env.type)) ended = true;
        if (!ended && !('error' in d)) pubs.push(`${e.time} ${e.peer} ${d.env.type}:${d.env.step} ${e.value.length}`);
      };
    },
    onView: (seat, v) => {
      if (seat !== S || v.terminal) return;
      const j = JSON.stringify({ game: v.game, role: v.role });
      if (views[views.length - 1] !== j) views.push(j);
    },
  });
  return { views, jobs: allJobs[S], allJobs, pubs, souls: [...r.peers[S].subscribed], r };
}

function untilEnd(jobs: string[]): string[] {
  const k = jobs.findIndex((x) => END_JOB.test(x));
  return k < 0 ? jobs : jobs.slice(0, k);
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
  // 3. Every seat's jobs and the whole publication log agree across the three deals until the assassination.
  assert.ok(ra.pubs.length > 60, `${ra.pubs.length} publications`);
  for (const x of [rb, rc]) {
    assert.deepEqual(x.pubs, ra.pubs);
    for (let j = 0; j < N; j++) {
      assert.ok(untilEnd(ra.allJobs[j]).length > 30);
      assert.deepEqual(untilEnd(x.allJobs[j]), untilEnd(ra.allJobs[j]), `jobs of seat ${j}`);
    }
  }
  // 4. The decryption allow-list.
  for (const x of [ra, rb, rc]) assert.deepEqual(allowListViolations(x.r), []);
});
