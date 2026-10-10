/**
 * Worker jobs (docs/p2p-protocol.md §7.5, §11.2 jobs.ts): batch verification
 * with per-job attribution, multi-statement jobs, reveal jobs, build tasks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexEncode, sha256, u32, utf8 } from '../crypto/bytes.ts';
import { encScalar, G, mod, mul } from '../crypto/group.ts';
import { encryptBit } from '../crypto/elgamal.ts';
import { proveSigma } from '../crypto/sigma.ts';
import { pokStatement } from '../crypto/statements.ts';
import { decodeEnvelope, encodeEnvelope } from './envelope.ts';
import { decodeStatement, runJobs, runProve, type VerifyJob } from './jobs.ts';
import { ect, encodeStatement, ept, reduceGame } from './machine.ts';
import { simConfig } from '../testing/simulate.ts';

const CONFIG_ID = hexEncode(sha256(utf8('jobs-test')));

function pokJob(i: number, tamper = false): VerifyJob {
  const x = mod(BigInt('0x' + hexEncode(sha256(utf8('x'), u32(i)))));
  const ctx = { configId: CONFIG_ID, stepId: 'key', prover: `P${i}` };
  const st = pokStatement(ctx, mul(G, x));
  const proof = proveSigma(st, 0, [x], { gameSeed: sha256(u32(i)), gameId: 'AAAAAAAAAAAAAAAAAAAAAA' });
  if (tamper) proof.s[0][0] = encScalar(mod(BigInt(proof.s[0][0].length) + 1n));
  return { id: hexEncode(sha256(u32(i))), kind: 'sigma', statement: encodeStatement(st), proofs: [proof] };
}

test('runJobs batch-verifies and attributes a single bad proof among many', () => {
  const jobs = Array.from({ length: 30 }, (_, i) => pokJob(i, i === 17));
  const vs = runJobs(jobs);
  vs.forEach((v, i) => assert.equal(v.ok, i !== 17, `job ${i}`));
  assert.deepEqual(runJobs(jobs.filter((_, i) => i !== 17)).map((v) => v.ok), Array(29).fill(true));
});

test('multi-statement jobs: every statement needs its own valid proof', () => {
  const a = pokJob(1);
  const b = pokJob(2);
  assert.ok(a.kind === 'sigma' && b.kind === 'sigma');
  const both: VerifyJob = { id: a.id, kind: 'sigma', statement: a.statement, proofs: [a.proofs[0], b.proofs[0]], more: [b.statement] };
  assert.deepEqual(runJobs([both]).map((v) => v.ok), [true]);
  const swapped: VerifyJob = { ...both, proofs: [b.proofs[0], a.proofs[0]] };
  const missing: VerifyJob = { ...both, proofs: [a.proofs[0]] };
  assert.deepEqual(runJobs([swapped, missing]).map((v) => v.ok), [false, false]);
});

test('statements round-trip through the job encoding', () => {
  const j = pokJob(3);
  assert.ok(j.kind === 'sigma');
  const st = decodeStatement(j.statement);
  assert.deepEqual(encodeStatement(st), j.statement);
  const bad: VerifyJob = { ...j, statement: { ...j.statement, branches: [{ nWitness: 1, eqs: [{ target: 'not-a-point', terms: [] }] }] } };
  assert.equal(runJobs([bad])[0].ok, false);
});

test('reveal jobs: key and ballot openings', () => {
  const x = 123456789n;
  const X = 987654321n;
  const Y = mul(G, X);
  const r = 5555n;
  const ballot = ect(encryptBit(Y, 1, r));
  const ok: VerifyJob = { id: 'a'.repeat(64), kind: 'reveal', x: encScalar(x), y: ept(mul(G, x)), Y: ept(Y), ballots: [{ r: encScalar(r), ballot }] };
  const wrongKey: VerifyJob = { ...ok, x: encScalar(x + 1n) };
  const wrongR: VerifyJob = { ...ok, ballots: [{ r: encScalar(r + 1n), ballot }] };
  assert.deepEqual(runJobs([ok, wrongKey, wrongR]).map((v) => v.ok), [true, false, false]);
});

test('runProve runs build tasks and rejects unknown tasks', () => {
  const { config, configMsg, lobbyId, signers } = simConfig(5, ['MERLIN'], 7);
  const ev = reduceGame({
    config, configId: configMsg.msgId, lobbyId, msgs: new Map(), verdicts: new Map(), conflictingConfigs: [], configAuthor: signers[0].pub,
  });
  const env = runProve({
    kind: 'build', fn: 'key',
    ctx: { config, configId: configMsg.msgId, lobbyId, seat: 2, me: signers[2].pub, ev, secrets: { gameSeed: new Uint8Array(32).fill(1) }, priv: null, now: 5 },
  });
  const enc = encodeEnvelope(env as Parameters<typeof encodeEnvelope>[0], signers[2]);
  const d = decodeEnvelope(enc.value, enc.key);
  assert.ok(!('error' in d));
  assert.equal(d.env.type, 'key');
  assert.equal(d.env.prev, configMsg.msgId);
  assert.throws(() => runProve({ kind: 'nope' }), /unknown task/);
});
