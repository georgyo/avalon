/**
 * In-process game simulations (docs/p2p-protocol.md §12): n SeatDrivers over a
 * MemoryTransport with seeded strategies for the human decisions. Fully
 * deterministic for given options (the transport has a virtual clock, every
 * driver works in microtasks, envelope `t` is constant), so two runs with the
 * same options produce byte-identical transcripts, and a reloaded seat must
 * reproduce the uninterrupted run exactly.
 */
import { b64uEncode, hexEncode, sha256, u32, utf8 } from '../crypto/bytes.ts';
import type { CardLabel } from '../crypto/types.ts';
import { SeatDriver, type CryptoBackend, type SeatView } from '../protocol/driver.ts';
import { encodeEnvelope, signerFromPair, type Signer } from '../protocol/envelope.ts';
import { runJobs, runProve, type VerifyJob } from '../protocol/jobs.ts';
import type { GameEval } from '../protocol/machine.ts';
import { ownLabel, seedRefOf, type GameSecrets, type PrivateView } from '../protocol/private.ts';
import { RULES_HASH, teamOf } from '../protocol/rules.ts';
import type { CancelReason, Envelope, GameConfig, Hex32, Journal, StoredMsg, Verdict } from '../protocol/types.ts';
import type { GameOutcome } from '../protocol/views.ts';
import { testPair } from '../protocol/lobbyTestkit.ts';
import { AdversaryTransport, rawEncode, soulForRaw, type Adversary, type AdversaryContext } from './adversary.ts';
import { MemoryTransport, seededRng, type MemPeer, type MemoryTransportOptions } from './memoryTransport.ts';

export const SIM_NAMES = ['ALICE', 'BOB', 'CAROL', 'DAVE', 'ERIN', 'FRANK', 'GRACE', 'HEIDI', 'IVAN', 'JUDY'];
export const SIM_LOBBY_CODE = 'SMPL';
/** Constant envelope clock: keeps transcripts byte-identical across runs and reloads. */
export const SIM_T = 1_760_000_000_000;

/** Seat-local decision context of a strategy. */
export interface DecisionCtx {
  seat: number;
  stepId: string;
  ev: GameEval;
  config: GameConfig;
  priv: PrivateView | null;
  /** Every seat's label (simulation omniscience), null where not yet known. */
  labels: (CardLabel | null)[];
  rng: () => number;
}

export interface ScriptedStrategy {
  propose(ctx: DecisionCtx): number[];
  vote(ctx: DecisionCtx): boolean;
  mission(ctx: DecisionCtx): boolean;
  assassinate(ctx: DecisionCtx): number;
}

export type StrategyName = 'random' | 'good-wins' | 'evil-wins' | 'merlin-dies' | 'reject';

export interface SimOptions {
  n: number;
  roles: string[];
  seed: number;
  strategy?: StrategyName | ScriptedStrategy;
  adversary?: Adversary;
  /** Replace the seat's driver by a fresh one (same gs_j and journal) when its pending step is `step` ('end': once terminal). */
  reloadAt?: { seat: number; step: string }[];
  // ---- additions
  net?: MemoryTransportOptions;
  /** Per-game seeds gs_j (default: derived from `seed`). */
  gameSeeds?: Uint8Array[];
  /** Seat cancels when its pending step is `step`. */
  cancelAt?: { seat: number; step: string; reason?: CancelReason; after?: number }[];
  /** Seat's device goes away (driver stopped) when `at` matches its evaluation. 'end' = once terminal (never reveals). */
  stall?: { seat: number; at: string | ((ev: GameEval) => boolean) }[];
  /** Crypto backend per seat (default: local, with verdicts memoized across seats). */
  crypto?: (seat: number) => CryptoBackend;
  /** Called after every evaluation of every seat (tests: partitions, restarts, assertions). */
  onEval?: (seat: number, ev: GameEval, sim: SimHandle) => void;
  /** Called with every view of every seat. */
  onView?: (seat: number, view: SeatView, sim: SimHandle) => void;
  maxEvents?: number;
  /** Human think time in virtual ms [min, max]. */
  thinkMs?: [number, number];
}

export interface SimHandle {
  transport: MemoryTransport;
  peers: MemPeer[];
  drivers: SeatDriver[];
  config: GameConfig;
  configId: Hex32;
  secrets: GameSecrets[];
  signers: Signer[];
}

export interface SimSeat {
  seat: number;
  name: string;
  driver: SeatDriver;
  journal: MemJournal;
  outcome: GameOutcome | null;
  ev: GameEval | null;
  view: SeatView | null;
  /** The values this seat journaled (= published), by slot. */
  published: Map<string, string>;
}

export interface SimResult {
  config: GameConfig;
  configId: Hex32;
  lobbyId: Hex32;
  configMsg: StoredMsg;
  seats: SimSeat[];
  transport: MemoryTransport;
  peers: MemPeer[];
  /** The outcome as seen by the first honest seat (not the adversary, not stalled). */
  outcome: GameOutcome | null;
  ev: GameEval | null;
  /** Every value stored by the relay, sorted (game souls and logs). */
  transcript: string[];
  /** The true deal (oracle). */
  labels: (CardLabel | null)[];
  secrets: GameSecrets[];
  signers: Signer[];
  errors: string[];
  honest: number;
  /** Number of driver reloads performed (reloadAt). */
  reloads: number;
}

export class MemJournal implements Journal {
  readonly entries = new Map<string, Map<string, string>>();
  async get(scope: string, slot: string): Promise<string | null> {
    return this.entries.get(scope)?.get(slot) ?? null;
  }
  async put(scope: string, slot: string, value: string): Promise<void> {
    let m = this.entries.get(scope);
    if (m === undefined) this.entries.set(scope, (m = new Map()));
    m.set(slot, value);
  }
  async all(scope: string): Promise<string[]> {
    return [...(this.entries.get(scope)?.values() ?? [])];
  }
}

/** A local backend whose verdicts are shared by every seat using the same memo (identical verdicts, one verification). */
export function memoCrypto(memo: Map<Hex32, Verdict>, record?: (kind: string, size: string) => void): CryptoBackend {
  return {
    async verify(jobs: VerifyJob[]): Promise<Verdict[]> {
      for (const j of jobs) record?.('verify', jobShape(j));
      const todo = jobs.filter((j) => !memo.has(j.id));
      const vs = runJobs(todo);
      todo.forEach((j, i) => memo.set(j.id, vs[i]));
      return jobs.map((j) => memo.get(j.id) ?? { ok: false, reason: 'missing' });
    },
    async prove(task) {
      const out = runProve(task);
      record?.('prove:' + String(task.fn), shapeOf(out));
      return out;
    },
  };
}

/** The shape of a verify job: proof type, branches and equations per branch (role-independent work, §9). */
export function jobShape(j: VerifyJob): string {
  if (j.kind === 'reveal') return `reveal/${j.ballots.length}`;
  return [j.statement, ...(j.more ?? [])].map((s) => `${s.proofType}:${s.branches.map((b) => `${b.nWitness}x${b.eqs.length}`).join(',')}`).join('+');
}

/** Structural size of a built envelope: key names and string lengths (equal for every role, §9). */
export function shapeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '[' + v.map(shapeOf).join(',') + ']';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).sort().filter((k) => k !== 't').map((k) => k + ':' + shapeOf(o[k])).join(',') + '}';
  }
  if (typeof v === 'string') return 's' + v.length;
  return typeof v;
}

export function simGameSeed(seed: number, seat: number, attempt = 0): Uint8Array {
  return sha256(utf8('sim-game-seed'), u32(seed >>> 0), u32(seat), u32(attempt));
}

export function simConfig(n: number, roles: string[], seed: number): { config: GameConfig; configMsg: StoredMsg; lobbyId: Hex32; signers: Signer[] } {
  const signers = Array.from({ length: n }, (_, i) => signerFromPair(testPair(1000 + i)));
  const lobbyId = hexEncode(sha256(utf8('sim-lobby'), u32(seed >>> 0)));
  const config: GameConfig = {
    gameId: b64uEncode(sha256(utf8('sim-game'), u32(seed >>> 0)).slice(0, 16)),
    seats: signers.map((s, i) => ({ pub: s.pub, name: SIM_NAMES[i] })),
    selectedRoles: [...roles],
    options: { inGameLog: false },
    rulesHash: RULES_HASH,
  };
  const env: Envelope<'lobby.config'> = {
    v: 1, type: 'lobby.config', lobby: lobbyId, game: '', step: '', author: signers[0].pub,
    prev: hexEncode(sha256(utf8('sim-roster'), u32(seed >>> 0))), t: SIM_T, body: config,
  };
  const enc = encodeEnvelope(env, signers[0]);
  return { config, configMsg: { msgId: enc.msgId, env, value: enc.value, key: enc.key }, lobbyId, signers };
}

// ---------------------------------------------------------------- strategies

function shuffled<T>(xs: readonly T[], rng: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function teamSizeOf(ctx: DecisionCtx): number {
  const cur = ctx.ev.state.cursor;
  return cur.t === 'p' ? ctx.ev.state.missions[cur.m].teamSize : 0;
}

function failsRequiredOf(ctx: DecisionCtx): number {
  const cur = ctx.ev.state.cursor;
  return cur.t === 'p' ? ctx.ev.state.missions[cur.m].failsRequired : 1;
}

function isEvil(l: CardLabel | null): boolean {
  return l !== null && teamOf(l.role) === 'evil';
}

function rotation(seat: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => (seat + i) % n);
}

const RANDOM: ScriptedStrategy = {
  propose: (c) => [c.seat, ...shuffled(rotation(c.seat, c.config.seats.length).slice(1), c.rng)].slice(0, teamSizeOf(c)),
  vote: (c) => c.rng() < (c.stepId.endsWith('/4') ? 0.9 : 0.6),
  mission: (c) => (isEvil(c.priv?.label ?? null) ? c.rng() < 0.5 : c.rng() < 0.8),
  assassinate: (c) => shuffled(rotation(c.seat, c.config.seats.length).slice(1), c.rng)[0],
};

const GOOD_WINS: ScriptedStrategy = {
  propose: (c) => {
    const good = rotation(c.seat, c.config.seats.length).filter((j) => !isEvil(c.labels[j]));
    return good.slice(0, teamSizeOf(c));
  },
  vote: () => true,
  mission: () => true,
  assassinate: (c) => rotation(c.seat, c.config.seats.length).slice(1)
    .find((j) => !isEvil(c.labels[j]) && c.labels[j]?.role !== 'MERLIN') ?? (c.seat + 1) % c.config.seats.length,
};

const EVIL_WINS: ScriptedStrategy = {
  propose: (c) => {
    const n = c.config.seats.length;
    const evil = rotation(c.seat, n).filter((j) => isEvil(c.labels[j]));
    const need = failsRequiredOf(c);
    const team = evil.slice(0, need);
    for (const j of rotation(c.seat, n)) if (team.length < teamSizeOf(c) && !team.includes(j)) team.push(j);
    return team;
  },
  vote: () => true,
  mission: (c) => !isEvil(c.priv?.label ?? null),
  assassinate: (c) => c.labels.findIndex((l) => l?.role === 'MERLIN'),
};

const MERLIN_DIES: ScriptedStrategy = { ...GOOD_WINS, assassinate: (c) => c.labels.findIndex((l) => l?.role === 'MERLIN') };
const REJECT: ScriptedStrategy = { ...RANDOM, vote: () => false };

function strategyOf(s: SimOptions['strategy']): ScriptedStrategy {
  if (s === undefined || s === 'random') return RANDOM;
  if (s === 'good-wins') return GOOD_WINS;
  if (s === 'evil-wins') return EVIL_WINS;
  if (s === 'merlin-dies') return MERLIN_DIES;
  if (s === 'reject') return REJECT;
  return s;
}

// ---------------------------------------------------------------- simulate

/** Runs one game to quiescence. */
export async function simulate(o: SimOptions): Promise<SimResult> {
  const n = o.n;
  const { config, configMsg, lobbyId, signers } = simConfig(n, o.roles, o.seed);
  const configId = configMsg.msgId;
  const secrets: GameSecrets[] = Array.from({ length: n }, (_, j) => ({ gameSeed: o.gameSeeds?.[j] ?? simGameSeed(o.seed, j) }));
  const transport = new MemoryTransport({ seed: o.seed, ...o.net });
  const peers = Array.from({ length: n }, () => transport.peer());
  const journals = Array.from({ length: n }, () => new MemJournal());
  const memo = new Map<Hex32, Verdict>();
  const cryptoOf = o.crypto ?? ((): CryptoBackend => memoCrypto(memo));
  const backends = Array.from({ length: n }, (_, j) => cryptoOf(j));
  const strategy = strategyOf(o.strategy);
  const errors: string[] = [];
  const pending = new Set<Promise<unknown>>();
  const acted = new Set<string>();
  const reloadsDone = new Set<string>();
  const cancelsDone = new Set<string>();
  const stopped = new Set<number>();
  let reloadCount = 0;
  const think = o.thinkMs ?? [50, 400];
  const drivers: SeatDriver[] = [];
  const adv = o.adversary;

  const track = (p: Promise<unknown>, what: string): void => {
    const q = p.catch((e: unknown) => errors.push(`${what}: ${e instanceof Error ? e.message : String(e)}`)).finally(() => pending.delete(q));
    pending.add(q);
  };

  const handle: SimHandle = { transport, peers, drivers, config, configId, secrets, signers };

  let advCtx: AdversaryContext | null = null;
  const advTransport = adv === undefined ? null
    : new AdversaryTransport(peers[adv.seat], adv, signers[adv.seat], config.gameId, () => drivers[adv.seat]?.evaluation ?? null);
  if (adv !== undefined && advTransport !== null) {
    advCtx = {
      config, configId, lobbyId, lobbyCode: SIM_LOBBY_CODE, seat: adv.seat, signer: signers[adv.seat], secrets: secrets[adv.seat],
      seed: seedRefOf(config, secrets[adv.seat]),
      publish: (env: unknown): Hex32 => {
        const enc = rawEncode(env, signers[adv.seat]);
        const soul = soulForRaw(env as { type?: unknown }, config.gameId);
        advTransport.publishRaw(soul, enc.key, enc.value).catch(() => undefined);
        return enc.msgId;
      },
      driver: () => drivers[adv.seat],
      drivers: () => drivers,
    };
    adv.init?.(advCtx);
  }

  const labelsNow = (): (CardLabel | null)[] => drivers.map((d) => d.privateView?.label ?? null);

  const decide = (j: number, ev: GameEval, stepId: string): DecisionCtx => ({
    seat: j, stepId, ev, config, priv: drivers[j].privateView, labels: labelsNow(),
    rng: seededRng('sim-decision', o.seed, j, stepId),
  });

  const humanAct = (j: number, stepId: string, type: string): void => {
    const d = drivers[j];
    const ev = d.evaluation;
    if (stopped.has(j) || ev === null || ev.terminal !== null || ev.pending?.step.id !== stepId) return;
    const c = decide(j, ev, stepId);
    let p: Promise<void>;
    switch (type) {
      case 'propose': p = d.propose(strategy.propose(c)); break;
      case 'vote.commit': p = d.vote(strategy.vote(c)); break;
      case 'ballot': p = d.mission(strategy.mission(c)); break;
      case 'assassinate': p = d.assassinate(strategy.assassinate(c)); break;
      default: return;
    }
    track(p, `seat ${j} ${stepId}`);
  };

  const maybeAct = (j: number, ev: GameEval): void => {
    if (stopped.has(j)) return;
    const p = ev.pending;
    if (ev.terminal !== null || p === null) return;
    for (const c of o.cancelAt ?? []) {
      const k = `${c.seat}/${c.step}`;
      if (c.seat === j && c.step === p.step.id && !cancelsDone.has(k)) {
        cancelsDone.add(k);
        transport.schedule(c.after ?? 1, () => {
          if (!stopped.has(j)) track(drivers[j].cancel(c.reason ?? 'cancel'), `seat ${j} cancel`);
        });
      }
    }
    if (ev.pendingReveals.length > 0) return;
    const human = (p.step.kind === 'human' && p.missing.includes(j))
      || (p.step.kind === 'assassination' && drivers[j].privateView?.label.assassin === true);
    if (!human) return;
    const key = `${j}/${p.step.id}`;
    if (acted.has(key)) return;
    acted.add(key);
    const rng = seededRng('sim-think', o.seed, j, p.step.id);
    const delay = think[0] + Math.floor(rng() * (think[1] - think[0] + 1));
    const stepId = p.step.id;
    const type = p.step.type;
    transport.schedule(delay, () => humanAct(j, stepId, type));
  };

  const matches = (at: string | ((ev: GameEval) => boolean), ev: GameEval): boolean => {
    if (typeof at === 'function') return at(ev);
    if (at === 'end') return ev.terminal !== null;
    return ev.terminal === null && ev.pending?.step.id === at;
  };

  /** Reached: the step is pending or already on the natural chain ('end': terminal). */
  const reached = (step: string, ev: GameEval): boolean => {
    if (step === 'end') return ev.terminal !== null;
    return ev.pending?.step.id === step || ev.chain.some((c) => c.stepId === step);
  };

  const makeDriver = (j: number): SeatDriver => new SeatDriver({
    config, configId, lobbyId, lobbyCode: SIM_LOBBY_CODE, seat: j, signer: signers[j], secrets: secrets[j],
    transport: advTransport !== null && adv?.seat === j ? advTransport : peers[j],
    journal: journals[j], crypto: backends[j], now: () => SIM_T, configAuthor: signers[0].pub, createdAt: SIM_T,
    onError: (e) => errors.push(`seat ${j}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`),
    onView: (v) => o.onView?.(j, v, handle),
    onEval: (ev) => {
      if (drivers[j] === undefined || stopped.has(j)) return;
      for (const s of o.stall ?? []) {
        if (s.seat === j && matches(s.at, ev)) {
          stopped.add(j);
          drivers[j].stop();
          return;
        }
      }
      for (const r of o.reloadAt ?? []) {
        const k = `${r.seat}/${r.step}`;
        if (r.seat === j && !reloadsDone.has(k) && reached(r.step, ev)) {
          reloadsDone.add(k);
          transport.schedule(0, () => {
            if (stopped.has(j)) return;
            reloadCount++;
            drivers[j].stop();
            drivers[j] = makeDriver(j);
            track(drivers[j].start(), `seat ${j} restart`);
          });
        }
      }
      if (adv !== undefined && adv.seat === j && advCtx !== null) adv.onEval?.(ev, advCtx);
      o.onEval?.(j, ev, handle);
      maybeAct(j, ev);
    },
  });

  for (let j = 0; j < n; j++) drivers.push(makeDriver(j));
  for (let j = 0; j < n; j++) {
    peers[j].onRestart(() => {
      if (!stopped.has(j)) track(drivers[j].republish(true), `seat ${j} republish`);
    });
  }
  for (let j = 0; j < n; j++) track(drivers[j].start(), `seat ${j} start`);

  const idle = async (): Promise<void> => {
    for (let guard = 0; guard < 1000; guard++) {
      await Promise.all(drivers.map((d) => d.idle()));
      if (pending.size > 0) {
        await Promise.all([...pending]);
        continue;
      }
      if (drivers.every((d) => d.idleNow)) return;
    }
    throw new Error('simulation does not settle');
  };
  await transport.run(idle, { maxEvents: o.maxEvents ?? 200_000 });

  const honest = drivers.findIndex((_, j) => j !== adv?.seat && !stopped.has(j));
  const ev = honest >= 0 ? drivers[honest].evaluation : null;
  const labels = drivers.map((_, j) => (ev === null ? null : ownLabel(config, ev, j, secrets[j])));
  const seats: SimSeat[] = drivers.map((d, j) => ({
    seat: j, name: SIM_NAMES[j], driver: d, journal: journals[j], outcome: d.outcome, ev: d.evaluation, view: d.view,
    published: new Map(journals[j].entries.get(configId) ?? []),
  }));
  return {
    config, configId, lobbyId, configMsg, seats, transport, peers,
    outcome: honest >= 0 ? drivers[honest].outcome : null, ev,
    transcript: transport.values(), labels, secrets, signers, errors, honest, reloads: reloadCount,
  };
}




