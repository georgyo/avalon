/**
 * Attack helpers and assertions for the cheating scenarios of
 * docs/p2p-protocol.md §10, §12. A cheater forges with the internal unchecked
 * prover of common/crypto (the public proveSigma refuses false witnesses).
 */
import assert from 'node:assert/strict';
import { hexEncode, sha256, utf8 } from '../crypto/bytes.ts';
import { G, mod, decScalar, encScalar, type Scalar } from '../crypto/group.ts';
import { proveSigma, type ProofContext, type Statement } from '../crypto/sigma.ts';
import { proveSigmaUnchecked } from '../crypto/sigmaCore.ts';
import type { SeedRef } from '../crypto/derive.ts';
import type { CardLabel, SigmaProofE } from '../crypto/types.ts';
import { decodeEnvelope } from '../protocol/envelope.ts';
import { configInfo, dpt, ept, finalA, type ConfigInfo, type GameEval } from '../protocol/machine.ts';
import { secretKey } from '../protocol/private.ts';
import { teamOf } from '../protocol/rules.ts';
import type { Envelope, Hex32, StoredMsg } from '../protocol/types.ts';
import type { GameOutcome } from '../protocol/views.ts';
import type { AdversaryContext } from './adversary.ts';
import { simConfig, simGameSeed, type SimOptions, type SimResult } from './simulate.ts';
import { predictDeal } from './predict.ts';
import { assertAgreement } from './simkit.ts';

/** Asserts that the public prover refuses the false witness, then forges the proof a cheater would publish. */
export function forge(st: Statement, real: number, witness: Scalar[], seed: SeedRef): SigmaProofE {
  assert.throws(() => proveSigma(st, real, witness, seed), /witness does not satisfy/);
  return proveSigmaUnchecked(st, real, witness, seed);
}

export function info(ctx: AdversaryContext): ConfigInfo {
  return configInfo(ctx.config, ctx.configId);
}

export function xOf(ctx: AdversaryContext): Scalar {
  return secretKey(ctx.config, ctx.secrets);
}

export function pctx(ctx: AdversaryContext, stepId: string): ProofContext {
  return { configId: ctx.configId, stepId, prover: ctx.signer.pub };
}

export function own(view: GameEval, seat: number): { A: ReturnType<typeof dpt>; C: ReturnType<typeof dpt>; y: ReturnType<typeof dpt> } {
  const A = finalA(view.state);
  assert.ok(A !== null && view.state.C !== null && view.state.y !== null);
  return { A: dpt(A[seat]), C: dpt(view.state.C[seat]), y: dpt(view.state.y[seat]) };
}

/** A scalar string shifted by one (a broken proof response). */
export function bumpScalar(s: string): string {
  return encScalar(mod(decScalar(s) + 1n));
}

/** A point string shifted by G. */
export function bumpPoint(p: string): string {
  return ept(dpt(p).add(G));
}

export function copy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** A copy with a different `t`: an identical body under a different msgId (equivocation). */
export function twin<T extends Envelope>(env: T): T {
  return { ...copy(env), t: env.t + 1 };
}

export function randomHex(label: string): Hex32 {
  return hexEncode(sha256(utf8(label)));
}

/** The deal a simulation with these options will produce. */
export function dealOf(o: Pick<SimOptions, 'n' | 'roles' | 'seed'>): CardLabel[] {
  const { config, configMsg } = simConfig(o.n, o.roles, o.seed);
  return predictDeal(config, configMsg.msgId, Array.from({ length: o.n }, (_, j) => ({ gameSeed: simGameSeed(o.seed, j) }))).labels;
}

export function seatWith(labels: CardLabel[], pred: (l: CardLabel) => boolean): number {
  const j = labels.findIndex(pred);
  assert.ok(j >= 0, 'no seat with the wanted card');
  return j;
}

export function honestSeats(r: SimResult, adversary: number, extra: number[] = []): number[] {
  return r.seats.map((s) => s.seat).filter((j) => j !== adversary && !extra.includes(j));
}

/**
 * The game ended INVALID with `seat` as the primary cheater for `reason`, every
 * honest seat agrees, and the forfeit row of §5.13 applies.
 */
export function assertInvalid(r: SimResult, seat: number, reason: string | RegExp, o?: { atStep?: string; others?: number[] }): GameOutcome {
  const honest = honestSeats(r, seat, o?.others ?? []);
  for (const j of honest) {
    const t = r.seats[j].ev?.terminal;
    assert.equal(t?.kind, 'invalid', `seat ${j}: ${JSON.stringify(t)} pending ${r.seats[j].ev?.pending?.step.id}`);
    assert.equal(t?.by, seat, `seat ${j}: primary cheater`);
    const f = t?.faults.find((x) => x.seat === seat);
    assert.ok(f !== undefined);
    if (typeof reason === 'string') assert.equal(f.reason, reason);
    else assert.match(f.reason, reason);
    if (o?.atStep !== undefined) assert.equal(t?.atStep, o.atStep);
    // No honest seat is blamed.
    for (const g of t?.faults ?? []) assert.ok(!honest.includes(g.seat) || (o?.others ?? []).includes(g.seat), `honest seat ${g.seat} blamed`);
  }
  const out = assertAgreement(r, honest);
  const name = r.config.seats[seat].name;
  assert.ok(out.cheaters.some((c) => c.name === name), JSON.stringify(out.cheaters));
  const label = out.roles[seat]?.role;
  if (label !== undefined && label !== 'UNKNOWN') {
    const team = teamOf(label);
    assert.equal(out.state, team === 'evil' ? 'GOOD_WIN' : 'EVIL_WIN');
    assert.match(out.message, new RegExp(`^${name} cheated \\(.*\\); ${team} forfeits$`));
  } else {
    assert.equal(out.state, 'CANCELED');
    assert.match(out.message, new RegExp(`^Game invalid: ${name} cheated`));
  }
  return out;
}

/**
 * Secret-dependent messages (deal shares, tally shares, openings) of honest seats
 * all build on one branch: for each step, every honest seat used the same prev,
 * and no honest seat released two of them for one step.
 */
export function assertSingleBranch(r: SimResult, adversary: number): void {
  const byStep = new Map<string, Set<Hex32>>();
  for (const j of honestSeats(r, adversary)) {
    const counts = new Map<string, number>();
    for (const v of r.transcript) {
      const m = decodeQuick(v);
      if (m === null || m.env.author !== r.config.seats[j].pub) continue;
      if (m.env.type !== 'deal' && m.env.type !== 'tally' && m.env.type !== 'assassinate') continue;
      counts.set(m.env.step, (counts.get(m.env.step) ?? 0) + 1);
      let s = byStep.get(m.env.step);
      if (s === undefined) byStep.set(m.env.step, (s = new Set()));
      s.add(m.env.prev);
    }
    for (const [step, c] of counts) assert.equal(c, 1, `seat ${j} released ${c} messages at ${step}`);
  }
  for (const [step, prevs] of byStep) assert.equal(prevs.size, 1, `honest seats built ${step} on ${prevs.size} branches`);
}

function decodeQuick(v: string): StoredMsg | null {
  const d = decodeEnvelope(v);
  return 'error' in d ? null : d;
}
