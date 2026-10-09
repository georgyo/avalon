/**
 * Worker jobs (docs/p2p-protocol.md §7.5, §11.2): self-contained, encoded,
 * worker-safe. `runJobs` batch-verifies sigma proofs and falls back to
 * per-job verification to attribute a failure; `runProve` runs a build task
 * (the builders of build.ts, which do all proving) off the main thread.
 *
 * Deviation from §11.2 (documented): an `ot.send` message carries two proofs
 * over two statements (ot-profile and ot-eq), which the spec's
 * `{ statement, proofs }` shape cannot express. A sigma job therefore carries
 * `statement` plus optional `more` statements; `proofs[0]` proves `statement`
 * and `proofs[i]` proves `more[i - 1]`. A spec-shaped single-statement job is a
 * valid job.
 */
import { b64uDecode } from '../crypto/bytes.ts';
import { decScalar, G, mulPub, O, type Point } from '../crypto/group.ts';
import { BatchVerifier, verifySigma, type ProofContext, type ProofType, type Statement } from '../crypto/sigma.ts';
import type { B64, CtE, Hex32, Pt, Sc, SigmaProofE } from '../crypto/types.ts';
import {
  buildAssassinate, buildBallot, buildCancel, buildDeal, buildKey, buildLog, buildOtRecv, buildOtSend, buildPropose,
  buildReveal, buildShuffle, buildTally, buildVoteCommit, buildVoteReveal, type BuildCtx,
} from './build.ts';
import { dptAny, Lru } from './machine.ts';
import type { CancelReason, Envelope, Verdict } from './types.ts';
import type { GameOutcome } from './views.ts';

/** Statement with points encoded (§2.2). */
export type EncodedStatement = {
  proofType: ProofType; ctx: ProofContext; aux: B64;
  branches: { nWitness: number; eqs: { target: Pt; terms: { w: number; base: Pt }[] }[] }[];
};

export type VerifyJob =
  | { id: Hex32 /* msgId */; kind: 'sigma'; statement: EncodedStatement; proofs: SigmaProofE[]; more?: EncodedStatement[] }
  | { id: Hex32; kind: 'reveal'; x: Sc; y: Pt; Y: Pt; ballots: { r: Sc; ballot: CtE }[] };

export type ProveTask = { kind: string; [k: string]: unknown };

/** The build functions a worker can run. */
export type BuildTask =
  | { kind: 'build'; fn: 'key' | 'shuffle' | 'deal' | 'otRecv' | 'otSend' | 'tally' | 'reveal'; ctx: BuildCtx }
  | { kind: 'build'; fn: 'propose'; ctx: BuildCtx; team: number[] }
  | { kind: 'build'; fn: 'voteCommit'; ctx: BuildCtx; approve: boolean }
  | { kind: 'build'; fn: 'voteReveal'; ctx: BuildCtx; commitEnv: Envelope<'vote.commit'> }
  | { kind: 'build'; fn: 'ballot'; ctx: BuildCtx; success: boolean }
  | { kind: 'build'; fn: 'assassinate'; ctx: BuildCtx; target: number }
  | { kind: 'build'; fn: 'cancel'; ctx: BuildCtx; reason: CancelReason }
  | { kind: 'build'; fn: 'log'; ctx: BuildCtx; outcome: GameOutcome; lobbyCode: string; createdAt?: number };

// ---------------------------------------------------------------- statements

const stCache = new Lru<string, Point>(1 << 14);

function dp(s: Pt): Point {
  const hit = stCache.get(s);
  if (hit !== undefined) return hit;
  const P = dptAny(s);
  stCache.set(s, P);
  return P;
}

/** Decodes a job statement (computed by the verifier itself, so the identity is allowed). Throws on malformed input. */
export function decodeStatement(e: EncodedStatement): Statement {
  return {
    proofType: e.proofType,
    ctx: { configId: e.ctx.configId, stepId: e.ctx.stepId, prover: e.ctx.prover },
    aux: b64uDecode(e.aux),
    branches: e.branches.map((br) => ({
      nWitness: br.nWitness,
      eqs: br.eqs.map((eq) => ({ target: dp(eq.target), terms: eq.terms.map((t) => ({ w: t.w, base: dp(t.base) })) })),
    })),
  };
}

function jobStatements(job: Extract<VerifyJob, { kind: 'sigma' }>): Statement[] {
  return [job.statement, ...(job.more ?? [])].map(decodeStatement);
}

function checkReveal(job: Extract<VerifyJob, { kind: 'reveal' }>): Verdict {
  try {
    const x = decScalar(job.x);
    if (x === 0n || !mulPub(G, x).equals(dp(job.y))) return { ok: false, reason: 'key does not match' };
    const Y = dp(job.Y);
    for (const b of job.ballots) {
      const r = decScalar(b.r);
      const a = dp(b.ballot.a);
      const X = dp(b.ballot.b).subtract(mulPub(Y, r));
      if (!mulPub(G, r).equals(a) || !(X.equals(O) || X.equals(G))) return { ok: false, reason: 'ballot opening does not match' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'malformed reveal' };
  }
}

function verifyOne(job: Extract<VerifyJob, { kind: 'sigma' }>): Verdict {
  let sts: Statement[];
  try {
    sts = jobStatements(job);
  } catch (e) {
    return { ok: false, reason: 'malformed statement: ' + (e instanceof Error ? e.message : String(e)) };
  }
  if (job.proofs.length !== sts.length) return { ok: false, reason: 'proof count mismatch' };
  for (let i = 0; i < sts.length; i++) if (!verifySigma(sts[i], job.proofs[i])) return { ok: false, reason: `proof ${i} rejected` };
  return { ok: true };
}

/**
 * Verifies jobs: all sigma proofs are folded into one batch MSM (§2.6.4); if the
 * batch fails, every job is re-verified individually so the failing ones are
 * attributed. Never throws.
 */
export function runJobs(jobs: VerifyJob[]): Verdict[] {
  const out: (Verdict | null)[] = jobs.map(() => null);
  const batch = new BatchVerifier();
  const batched: number[] = [];
  jobs.forEach((job, i) => {
    if (job.kind === 'reveal') {
      out[i] = checkReveal(job);
      return;
    }
    let sts: Statement[];
    try {
      sts = jobStatements(job);
    } catch (e) {
      out[i] = { ok: false, reason: 'malformed statement: ' + (e instanceof Error ? e.message : String(e)) };
      return;
    }
    if (job.proofs.length !== sts.length) {
      out[i] = { ok: false, reason: 'proof count mismatch' };
      return;
    }
    for (let k = 0; k < sts.length; k++) {
      if (!batch.add(sts[k], job.proofs[k])) {
        out[i] = { ok: false, reason: `proof ${k} rejected` };
        return;
      }
    }
    batched.push(i);
  });
  if (batched.length > 0) {
    if (batch.verify()) {
      for (const i of batched) out[i] = { ok: true };
    } else {
      for (const i of batched) {
        const job = jobs[i];
        out[i] = job.kind === 'sigma' ? verifyOne(job) : checkReveal(job);
      }
    }
  }
  return out.map((v) => v ?? { ok: false, reason: 'not verified' });
}

// ---------------------------------------------------------------- prove

function isBuildTask(t: ProveTask): t is BuildTask {
  return t.kind === 'build' && typeof t.fn === 'string' && typeof t.ctx === 'object' && t.ctx !== null;
}

/** Runs a build task (proving included) and returns the unsigned envelope. Throws on unknown tasks. */
export function runProve(task: ProveTask): unknown {
  if (!isBuildTask(task)) throw new Error(`runProve: unknown task kind ${task.kind}`);
  const ctx = task.ctx;
  switch (task.fn) {
    case 'key': return buildKey(ctx);
    case 'shuffle': return buildShuffle(ctx);
    case 'deal': return buildDeal(ctx);
    case 'otRecv': return buildOtRecv(ctx);
    case 'otSend': return buildOtSend(ctx);
    case 'tally': return buildTally(ctx);
    case 'reveal': return buildReveal(ctx);
    case 'propose': return buildPropose(ctx, task.team);
    case 'voteCommit': return buildVoteCommit(ctx, task.approve);
    case 'voteReveal': return buildVoteReveal(ctx, task.commitEnv);
    case 'ballot': return buildBallot(ctx, task.success);
    case 'assassinate': return buildAssassinate(ctx, task.target);
    case 'cancel': return buildCancel(ctx, task.reason);
    case 'log': return buildLog(ctx, task.outcome, task.lobbyCode, task.createdAt);
  }
}
