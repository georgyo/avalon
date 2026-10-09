/**
 * Transcript tools for machine tests (docs/p2p-protocol.md §12): evaluate a
 * message set to a fixed point of verdicts, sign extra envelopes for a seat,
 * and construct cancels and reveals at given chain positions.
 */
import { encScalar } from '../crypto/group.ts';
import { decodeEnvelope, encodeEnvelope, type Signer } from '../protocol/envelope.ts';
import { runJobs } from '../protocol/jobs.ts';
import { reduceGame, type GameEval } from '../protocol/machine.ts';
import { computeOutcome } from '../protocol/outcome.ts';
import { secretKey, type GameSecrets } from '../protocol/private.ts';
import type { CancelReason, Envelope, GameConfig, GameMsgType, Hex32, StoredMsg, Verdict, Bodies } from '../protocol/types.ts';
import type { GameOutcome } from '../protocol/views.ts';
import { rawEncode } from './adversary.ts';
import { simulate, type SimOptions, type SimResult } from './simulate.ts';

const verdictMemo = new Map<Hex32, Verdict>();

export interface EvalOptions {
  conflictingConfigs?: StoredMsg[];
  /** Default: seat 0 (the admin of every simulated table, simConfig). */
  configAuthor?: string;
  /** Default: the `lobby` field of the game's messages (simulated tables have one lobby). */
  lobbyId?: Hex32;
  verdicts?: Map<Hex32, Verdict>;
}

/** The lobbyId the game messages carry ('' when there are none). */
function lobbyOf(config: GameConfig, msgs: ReadonlyMap<Hex32, StoredMsg>): Hex32 {
  for (const m of msgs.values()) if (m.env.game === config.gameId && m.env.lobby !== '') return m.env.lobby;
  return '';
}

/** reduceGame with every needed verdict computed (iterated to a fixed point). */
export function evalFull(config: GameConfig, configId: Hex32, msgs: ReadonlyMap<Hex32, StoredMsg>, o?: EvalOptions): GameEval {
  const verdicts = o?.verdicts ?? new Map<Hex32, Verdict>();
  const configAuthor = o?.configAuthor ?? config.seats[0].pub;
  const lobbyId = o?.lobbyId ?? lobbyOf(config, msgs);
  for (let i = 0; i < 100; i++) {
    const ev = reduceGame({ config, configId, lobbyId, msgs, verdicts, conflictingConfigs: o?.conflictingConfigs ?? [], configAuthor });
    const todo = ev.jobs.filter((j) => !verdicts.has(j.id));
    if (todo.length === 0) return ev;
    const fresh = todo.filter((j) => !verdictMemo.has(j.id));
    const vs = runJobs(fresh);
    fresh.forEach((j, k) => verdictMemo.set(j.id, vs[k]));
    for (const j of todo) verdicts.set(j.id, verdictMemo.get(j.id) ?? { ok: false });
  }
  throw new Error('evalFull: no fixed point');
}

export function outcomeOf(config: GameConfig, configId: Hex32, msgs: ReadonlyMap<Hex32, StoredMsg>, o?: Parameters<typeof evalFull>[3]): { ev: GameEval; outcome: GameOutcome | null } {
  const ev = evalFull(config, configId, msgs, o);
  return { ev, outcome: computeOutcome(config, ev, msgs) };
}

/** Decodes relay values into a msgId map (game messages of `gameId` only). */
export function msgMap(values: Iterable<string>, gameId?: string): Map<Hex32, StoredMsg> {
  const out = new Map<Hex32, StoredMsg>();
  for (const v of values) {
    const d = decodeEnvelope(v);
    if ('error' in d) continue;
    if (gameId !== undefined && d.env.game !== gameId) continue;
    out.set(d.msgId, d);
  }
  return out;
}

export function withMsgs(base: ReadonlyMap<Hex32, StoredMsg>, ...extra: StoredMsg[]): Map<Hex32, StoredMsg> {
  const m = new Map(base);
  for (const x of extra) m.set(x.msgId, x);
  return m;
}

export function without(base: ReadonlyMap<Hex32, StoredMsg>, pred: (m: StoredMsg) => boolean): Map<Hex32, StoredMsg> {
  const m = new Map<Hex32, StoredMsg>();
  for (const [k, v] of base) if (!pred(v)) m.set(k, v);
  return m;
}

/** Signs a schema-valid envelope. */
export function signed(env: Envelope, signer: Signer): StoredMsg {
  const enc = encodeEnvelope(env, signer);
  return { msgId: enc.msgId, env: JSON.parse(JSON.stringify(env)) as Envelope, value: enc.value, key: enc.key };
}

/** Signs any envelope-like value (no schema validation; decoding by peers may reject it). */
export function signedRaw(env: unknown, signer: Signer): StoredMsg | null {
  const enc = rawEncode(env, signer);
  const d = decodeEnvelope(enc.value, enc.key);
  return 'error' in d ? null : d;
}

/** D_{k-1}: the digest before chain position k (configId for k = 0). */
export function digestBefore(ev: GameEval, configId: Hex32, k: number): Hex32 {
  return k === 0 ? configId : ev.chain[k - 1].digest;
}

/** Index of a step id on the evaluation's chain, or the pending/stop position. */
export function positionOf(ev: GameEval, stepId: string): number {
  const i = ev.chain.findIndex((c) => c.stepId === stepId);
  if (i >= 0) return i;
  if (ev.pending?.step.id === stepId) return ev.chain.length;
  throw new Error(`step ${stepId} not on the chain`);
}

export interface Table { config: GameConfig; configId: Hex32; lobbyId: Hex32; signers: Signer[]; secrets: GameSecrets[] }

/** A cancel by `seat` of chain position `k` (step `ev.chain[k]` or the pending step). */
export function cancelMsg(t: Table, ev: GameEval, seat: number, stepId: string, reason: CancelReason = 'cancel'): StoredMsg {
  const k = positionOf(ev, stepId);
  return signed({
    v: 1, type: 'cancel', lobby: t.lobbyId, game: t.config.gameId, step: 'cancel', author: t.signers[seat].pub,
    prev: digestBefore(ev, t.configId, k), t: 0, body: { at: stepId, reason },
  }, t.signers[seat]);
}

/** A reveal of seat `seat`'s key with the given basis (ballot entries omitted). */
export function revealMsg(t: Table, seat: number, basis: Hex32[], prev: Hex32): StoredMsg {
  const x = secretKey(t.config, t.secrets[seat]);
  return signed({
    v: 1, type: 'reveal', lobby: t.lobbyId, game: t.config.gameId, step: 'reveal', author: t.signers[seat].pub,
    prev, t: 0, body: { x: encScalar(x), ballots: [], basis },
  }, t.signers[seat]);
}

/** A game envelope of `seat` with an arbitrary body (signed, schema-checked). */
export function gameMsg<T extends GameMsgType>(t: Table, seat: number, type: T, step: string, prev: Hex32, body: Bodies[T]): StoredMsg {
  return signed({ v: 1, type, lobby: t.lobbyId, game: t.config.gameId, step, author: t.signers[seat].pub, prev, t: 0, body } as Envelope, t.signers[seat]);
}

/** Messages of the transcript in natural-chain order, then the others (stable). */
export function chainOrder(ev: GameEval, msgs: ReadonlyMap<Hex32, StoredMsg>): StoredMsg[] {
  const out: StoredMsg[] = [];
  const seen = new Set<Hex32>();
  for (const c of ev.chain) for (const id of c.msgIds) {
    const m = msgs.get(id);
    if (m !== undefined && !seen.has(id)) {
      out.push(m);
      seen.add(id);
    }
  }
  for (const [id, m] of msgs) if (!seen.has(id)) out.push(m);
  return out;
}

/** A recorded game: the table, every relay message of the game, and the full evaluation. */
export interface Recorded { r: SimResult; t: Table; msgs: Map<Hex32, StoredMsg>; ev: GameEval }

export async function recordGame(o: SimOptions): Promise<Recorded> {
  const r = await simulate(o);
  const t: Table = { config: r.config, configId: r.configId, lobbyId: r.lobbyId, signers: r.signers, secrets: r.secrets };
  const msgs = msgMap(r.transcript, r.config.gameId);
  return { r, t, msgs, ev: evalFull(r.config, r.configId, msgs) };
}

/** The stepped messages of chain positions < k (no cancels, reveals or logs): the game with step k pending. */
export function before(rec: Recorded, stepId: string): Map<Hex32, StoredMsg> {
  const k = positionOf(rec.ev, stepId);
  const ids = new Set(rec.ev.chain.slice(0, k).flatMap((c) => c.msgIds));
  return new Map([...rec.msgs].filter(([id]) => ids.has(id)));
}

/** The messages of chain step `stepId` by seat. */
export function stepMsgs(rec: Recorded, stepId: string): Map<number, StoredMsg> {
  const k = positionOf(rec.ev, stepId);
  const out = new Map<number, StoredMsg>();
  for (const id of rec.ev.chain[k]?.msgIds ?? []) {
    const m = rec.msgs.get(id);
    if (m !== undefined) out.set(rec.t.config.seats.findIndex((s) => s.pub === m.env.author), m);
  }
  return out;
}
