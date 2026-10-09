/**
 * SeatDriver (docs/p2p-protocol.md §3.4, §3.9, §7.7, §11.2): one seat's protocol
 * driver. DOM-free; runs in browsers (WP-D wraps it) and in node simulations.
 *
 * It ingests and verifies envelopes (§3.4), evaluates the game (reduceGame),
 * schedules verification jobs, derives the private view, publishes this seat's
 * messages through the once-only journal (§3.9) and runs the automatic steps of
 * §7.7. Human actions are published only from explicit calls, and only for the
 * current pending step.
 *
 * Additions to the §11.2 constructor (documented in the WP-C report):
 * `lobbyId` and `configAuthor` (required: game envelopes carry the lobbyId,
 * and only the config's author can equivocate on it, §4.6), and the optional
 * `conflictingConfigs`, `createdAt` and `onEval`. `secrets`
 * may be null for a device that lost its game record (§3.10): it can then only
 * cancel with reason 'lost'. Extra public members: `evaluation`,
 * `privateView`, `outcome`, `view`, `messages()`, `republish()`,
 * `setConflictingConfigs()`, `tick()`, `idle()`, `idleNow`.
 *
 * Every journal-writing publish runs under one driver-wide mutex, so a cancel
 * is serialized with the automatic and human publishes: it waits for those in
 * flight, then targets the step pending in a fresh evaluation, and once it is
 * journaled no step message of this seat can be journaled any more (§3.7
 * rule 2: an honest seat never cancels and continues).
 */
import type { Hex32, Pub } from '../crypto/types.ts';
import { decodeEnvelope, encodeEnvelope, gameSoul, gunKeyOf, parseEnvelope, soulOf, type Signer } from './envelope.ts';
import { runJobs, runProve, type BuildTask, type ProveTask, type VerifyJob } from './jobs.ts';
import type { BuildCtx } from './build.ts';
import { Lru, reduceGame, type GameEval } from './machine.ts';
import { computeOutcome } from './outcome.ts';
import { derivePrivate, type GameSecrets, type PrivateView } from './private.ts';
import { projectGame, projectProgress, projectRole } from './project.ts';
import type { StepDef } from './steps.ts';
import type {
  Bodies, CancelReason, Envelope, GameConfig, Journal, SetupProgress, StoredMsg, Transport, Verdict,
} from './types.ts';
import type { GameData, GameOutcome, RoleDoc } from './views.ts';
import type { LobbyState } from './lobby.ts';

export interface CryptoBackend { verify(jobs: VerifyJob[]): Promise<Verdict[]>; prove(task: ProveTask): Promise<unknown> }

/** A CryptoBackend that runs jobs on the calling thread (node tests, fallback). */
export function localCrypto(): CryptoBackend {
  return {
    verify: async (jobs) => runJobs(jobs),
    prove: async (task) => runProve(task),
  };
}

export interface SeatView {
  game: GameData;
  role: RoleDoc | null;
  progress: SetupProgress | null;
  pending: GameEval['pending'];
  terminal: boolean;
  outcome: GameOutcome | null;
}

export interface SeatDriverOptions {
  config: GameConfig;
  configId: Hex32;
  lobbyId: Hex32;
  lobbyCode: string;
  seat: number;
  signer: Signer;
  secrets: GameSecrets | null;
  transport: Transport;
  journal: Journal;
  crypto: CryptoBackend;
  verdictCache?: Map<Hex32, Verdict>;
  now: () => number;
  onView(v: SeatView): void;
  conflictingConfigs?: StoredMsg[];
  /** The config envelope's author (the admin): config equivocation is two configs by this author (§4.6). */
  configAuthor: Pub;
  /** The config envelope's t, for log bundles (§6). */
  createdAt?: number;
  /** Called after every evaluation (session status, tests). */
  onEval?: (ev: GameEval) => void;
  /** Called when an automatic action fails (diagnostics). */
  onError?: (e: unknown) => void;
}

const LOG_DELAY_MS = 120000;

const decodedCache = new Lru<Hex32, StoredMsg>(1 << 12);

/**
 * decodeEnvelope (§3.4 steps 1-2) behind a content-keyed cache: the result is a
 * pure function of the value, and the GUN key is its SHA-256, so re-deliveries
 * (echoes, republishes, other drivers in one process) skip the ECDSA check.
 */
export function decodeCached(value: string, key?: string, admit?: (env: Envelope) => boolean): StoredMsg | { error: string } {
  if (typeof value !== 'string') return { error: 'value is not a string' };
  const k = gunKeyOf(value);
  if (key !== undefined && key !== k) return { error: 'key is not the hash of the value' };
  const hit = decodedCache.get(k);
  if (hit !== undefined && hit.value === value) return admit === undefined || admit(hit.env) ? hit : { error: 'not admitted' };
  const d = decodeEnvelope(value, k, admit);
  if (!('error' in d)) decodedCache.set(k, d);
  return d;
}

function primeDecoded(d: StoredMsg): void {
  decodedCache.set(d.key, d);
}

/** A publish decided on an older evaluation whose step is no longer pending (nothing was built or sent). */
class StaleStepError extends Error {}

function isEnvelopeLike(v: unknown): v is Envelope {
  return typeof v === 'object' && v !== null && 'type' in v && 'body' in v && 'author' in v;
}

export class SeatDriver {
  readonly config: GameConfig;
  readonly configId: Hex32;
  readonly seat: number;
  private readonly o: SeatDriverOptions;
  private readonly scope: Hex32;
  private readonly setupSoul: string;
  private readonly playSoul: string;
  private readonly msgs = new Map<Hex32, StoredMsg>();
  private readonly verdicts: Map<Hex32, Verdict>;
  private readonly inflight = new Set<Hex32>();
  private readonly slotLocks = new Map<string, Promise<StoredMsg | null>>();
  private conflicting: StoredMsg[];
  private unsubs: (() => void)[] = [];
  private started = false;
  private stopped = false;
  private ev: GameEval | null = null;
  private priv: PrivateView | null = null;
  private outcomeValue: GameOutcome | null = null;
  private viewValue: SeatView | null = null;
  private lastViewJson = '';
  private evalScheduled = false;
  private acting = false;
  private actAgain = false;
  private busy = 0;
  private idleWaiters: (() => void)[] = [];
  private terminalAt: number | null = null;
  private keyed = false;
  /** Tail of the driver-wide publish mutex. */
  private lockTail: Promise<void> = Promise.resolve();
  /** Set synchronously by cancel(): no new automatic or human publish starts. */
  private cancelling = false;
  private cancelInFlight: Promise<void> | null = null;
  /** Basis msgIds of the journaled reveal still to re-put once known (§7.7, after a reload). */
  private readonly basisToResend = new Set<Hex32>();
  private readonly seatPubs: ReadonlySet<Pub>;

  constructor(o: SeatDriverOptions) {
    this.o = o;
    this.config = o.config;
    this.configId = o.configId;
    this.seat = o.seat;
    this.scope = o.configId;
    this.setupSoul = gameSoul(o.config.gameId, 'setup');
    this.playSoul = gameSoul(o.config.gameId, 'play');
    this.verdicts = o.verdictCache ?? new Map();
    this.conflicting = [...(o.conflictingConfigs ?? [])];
    this.seatPubs = new Set(o.config.seats.map((x) => x.pub));
    if (o.config.seats[o.seat]?.pub !== o.signer.pub) throw new Error('SeatDriver: the signer is not seated at this seat');
  }

  /** The latest evaluation. */
  get evaluation(): GameEval | null {
    return this.ev;
  }

  get privateView(): PrivateView | null {
    return this.priv;
  }

  get outcome(): GameOutcome | null {
    return this.outcomeValue;
  }

  get view(): SeatView | null {
    return this.viewValue;
  }

  /** Every verified message of this game, in ingestion order. */
  messages(): StoredMsg[] {
    return [...this.msgs.values()];
  }

  /** Subscribes to the setup and play souls (in that order, §7.3), republishes the journal, evaluates. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubs.push(this.o.transport.subscribe(this.setupSoul, (k, v) => this.ingest(this.setupSoul, k, v)));
    this.unsubs.push(this.o.transport.subscribe(this.playSoul, (k, v) => this.ingest(this.playSoul, k, v)));
    this.busy++;
    try {
      await this.republish(false);
    } finally {
      this.done();
    }
    this.scheduleEval();
  }

  stop(): void {
    this.stopped = true;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    const w = this.idleWaiters;
    this.idleWaiters = [];
    for (const f of w) f();
  }

  /** The ingestion pipeline (§3.4); returns true if the message was new and valid. */
  ingest(soul: string, key: string, value: string): boolean {
    if (this.stopped) return false;
    if (soul !== this.setupSoul && soul !== this.playSoul) return false;
    // Parsed but not yet verified: only this game's messages by its seats reach the ECDSA check, so
    // junk under the game souls (anyone may write there) costs every seat no verification and is not kept.
    const d = decodeCached(value, key, (env) => env.game === this.config.gameId && this.seatPubs.has(env.author));
    if ('error' in d) return false;
    let expected: string;
    try {
      expected = soulOf(d.env, this.o.lobbyCode);
    } catch {
      return false;
    }
    if (expected !== soul) return false;
    if (this.msgs.has(d.msgId)) return false;
    this.msgs.set(d.msgId, d);
    if (this.basisToResend.delete(d.msgId)) this.send(d);
    this.scheduleEval();
    return true;
  }

  /**
   * Re-puts every journal entry (§7.4) and, for a journaled reveal, every
   * envelope of its basis (now if known, else as soon as it is ingested), so a
   * peer that missed the deciding message is not left suspended; with `full`,
   * also the whole transcript (relay restarted empty).
   */
  async republish(full: boolean): Promise<void> {
    const values = await this.o.journal.all(this.scope);
    for (const value of values) {
      const d = decodeCached(value);
      if ('error' in d) continue;
      if (d.env.type === 'key') this.keyed = true;
      if (d.env.type === 'reveal') for (const id of (d.env.body as Bodies['reveal']).basis) this.basisToResend.add(id);
      this.ingestOwn(d);
      this.send(d);
    }
    this.flushBasis();
    if (full) for (const m of this.msgs.values()) this.send(m);
  }

  setConflictingConfigs(list: StoredMsg[]): void {
    this.conflicting = [...list];
    this.flushBasis();
    this.scheduleEval();
  }

  /** A known envelope by msgId: a game message or a conflicting config (basis items, §3.7 rule 3). */
  private known(id: Hex32): StoredMsg | undefined {
    return this.msgs.get(id) ?? this.conflicting.find((c) => c.msgId === id);
  }

  private flushBasis(): void {
    for (const id of [...this.basisToResend]) {
      const m = this.known(id);
      if (m === undefined) continue;
      this.basisToResend.delete(id);
      this.send(m);
    }
  }

  /** Re-runs time-based actions (the log write 120 s after the end, §6) and pending verifications. */
  tick(): void {
    this.scheduleEval();
  }

  /** True when no evaluation, verification, build or publish is in flight. */
  get idleNow(): boolean {
    return this.busy === 0 && !this.evalScheduled;
  }

  /** Resolves when no evaluation, verification, build or publish is in flight. */
  idle(): Promise<void> {
    if (this.busy === 0 && !this.evalScheduled) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  // ------------------------------------------------------------ human actions

  /** Team proposal (§5.7); `teamSeats` in any order. Rejects with the legacy server's messages. */
  async propose(teamSeats: number[]): Promise<void> {
    const ev = this.requireRunning();
    const p = ev.pending;
    if (p === null || p.step.type !== 'propose') throw new Error('Not in team proposal phase');
    if (p.step.req === 'assassin' || p.step.req[0] !== this.seat) throw new Error('You are not the proposer');
    const cur = ev.state.cursor;
    const size = cur.t === 'p' ? ev.state.missions[cur.m].teamSize : 0;
    const uniq = [...new Set(teamSeats)];
    if (uniq.length !== teamSeats.length || uniq.some((x) => !Number.isInteger(x) || x < 0 || x >= ev.state.n)) {
      throw new Error('Bad team: ' + teamSeats.join(','));
    }
    if (uniq.length !== size) throw new Error('Bad team size. Need ' + size);
    await this.publish(p.step.id, (ctx) => ({ kind: 'build', fn: 'propose', ctx, team: uniq }));
  }

  async vote(approve: boolean): Promise<void> {
    const ev = this.requireRunning();
    const p = ev.pending;
    if (p === null || p.step.type !== 'vote.commit') throw new Error('Not in proposal vote phase');
    await this.publish(p.step.id, (ctx) => ({ kind: 'build', fn: 'voteCommit', ctx, approve }));
  }

  /** Mission vote (§5.9); a good player's FAIL is cast as success. */
  async mission(success: boolean): Promise<void> {
    const ev = this.requireRunning();
    const p = ev.pending;
    if (p === null || p.step.type !== 'ballot') throw new Error('Not in mission phase');
    if (p.step.req === 'assassin' || !p.step.req.includes(this.seat)) throw new Error('You are not on the mission team');
    if (this.priv === null) throw new Error('Own role unknown');
    await this.publish(p.step.id, (ctx) => ({ kind: 'build', fn: 'ballot', ctx, success }));
  }

  /** Assassination (§5.10); allowed while a reveal is pending (see buildAssassinate). */
  async assassinate(targetSeat: number): Promise<void> {
    const ev = this.requireRunning(true);
    const p = ev.pending;
    if (p === null || p.step.type !== 'assassinate') throw new Error('Not in assassination phase');
    if (this.priv === null || !this.priv.label.assassin) throw new Error('You are not the assassin');
    if (!Number.isInteger(targetSeat) || targetSeat < 0 || targetSeat >= ev.state.n || targetSeat === this.seat) {
      throw new Error('Invalid assassination target');
    }
    await this.publish('as', (ctx) => ({ kind: 'build', fn: 'assassinate', ctx, target: targetSeat }));
  }

  /**
   * Cancel (§3.7, §7.7): first this seat's own message for a pending automatic
   * step whose gate is open (unless a reveal is pending: the driver is then
   * suspended), then the cancel. Refused during the assassination and, at the
   * mt/m before a possible assassination, once the own tally is journaled
   * (rule 2a; a click that publishes the tally stops there).
   *
   * Serialized with every other publish (the driver mutex): it waits for the
   * publishes in flight, then re-evaluates and re-checks on that snapshot, and
   * builds the cancel against the same snapshot. A device without secrets
   * (§3.10) first waits for the transport to deliver the souls and for every
   * verdict, so its cancel cannot target a step before one of its own earlier
   * messages.
   */
  cancel(reason: CancelReason): Promise<void> {
    if (this.cancelInFlight !== null) return this.cancelInFlight;
    const p = this.cancelOnce(reason).finally(() => {
      this.cancelling = false;
      this.cancelInFlight = null;
    });
    this.cancelInFlight = p;
    return p;
  }

  private async cancelOnce(reason: CancelReason): Promise<void> {
    const ev0 = this.requireEval();
    if (await this.o.journal.get(this.scope, 'cancel') !== null) {
      await this.publish('cancel', (ctx) => ({ kind: 'build', fn: 'cancel', ctx, reason }));
      return;
    }
    this.checkCancelable(ev0);
    this.cancelling = true;
    this.busy++;
    try {
      await this.withLock(async () => {
        if (this.o.secrets === null) await this.settleForLostCancel();
        let ev = this.evaluateNow();
        if (ev.terminal !== null) return;   // the game ended meanwhile: nothing left to cancel
        const p = this.checkCancelable(ev);
        const rule2a = p.step.type === 'tally' && ev.state.succeeded === 2 && ev.state.merlin;
        if (rule2a && await this.o.journal.get(this.scope, p.step.id) !== null) throw new Error('Canceling now would forfeit');
        if (p.step.kind === 'automatic' && p.gateOpen && p.missing.includes(this.seat) && this.o.secrets !== null
            && ev.pendingReveals.length === 0) {
          await this.publishAutomatic(p.step, true);
          if (rule2a) throw new Error('Canceling now would forfeit');
          ev = this.evaluateNow();
          if (ev.terminal !== null) return;
          this.checkCancelable(ev);   // the step may have completed: the cancel targets the new pending step
        }
        // Built against the very evaluation the checks ran on (not a later this.ev).
        const snapshot = ev;
        await this.publishLocked('cancel', (ctx) => ({ kind: 'build', fn: 'cancel', ctx, reason }), snapshot);
      });
    } finally {
      this.done();
    }
  }

  /** The pending step a cancel of `ev` targets; throws when no cancel is allowed (§3.7 rule 6). */
  private checkCancelable(ev: GameEval): NonNullable<GameEval['pending']> {
    if (ev.terminal !== null) throw new Error('The game is over');
    const p = ev.pending;
    if (p === null) throw new Error('The game is over');
    if (p.step.kind === 'assassination' || ev.state.phase === 'ASSASSINATION') throw new Error('Cannot cancel during the assassination');
    return p;
  }

  /**
   * §3.10 lost storage: this device's own earlier messages may not have synced
   * back yet. Wait for the transport to deliver both game souls (if it can
   * tell), then for every verdict the evaluation needs, so the cancel targets
   * the step after them (otherwise rule 2 would blame this honest seat).
   */
  private async settleForLostCancel(): Promise<void> {
    const t = this.o.transport;
    if (t.synced !== undefined) await Promise.all([t.synced(this.setupSoul), t.synced(this.playSoul)]);
    for (let i = 0; i < 1000 && !this.stopped; i++) {
      const ev = this.evaluateNow();
      const todo = ev.jobs.filter((j) => !this.verdicts.has(j.id));
      if (todo.length === 0) return;
      const vs = await this.o.crypto.verify(todo);
      todo.forEach((j, k) => {
        const v = vs[k];
        if (v !== undefined) this.verdicts.set(j.id, v.ok ? { ok: true } : { ok: false, reason: v.reason ?? 'invalid' });
      });
      if (todo.every((j) => !this.verdicts.has(j.id))) return;
    }
  }

  // ------------------------------------------------------------ internals

  private requireEval(): GameEval {
    if (this.stopped) throw new Error('Stopped');
    return this.ev ?? this.evaluateNow();
  }

  private requireRunning(allowPendingReveals = false): GameEval {
    const ev = this.requireEval();
    if (this.cancelling) throw new Error('Canceling the game');
    if (ev.terminal !== null) throw new Error('The game is over');
    if (ev.pendingReveals.length > 0 && !allowPendingReveals) throw new Error('Waiting for messages cited by a reveal');
    if (this.o.secrets === null) throw new Error('This browser lost the secret keys for this game');
    return ev;
  }

  private done(): void {
    this.busy--;
    if (this.busy === 0) {
      queueMicrotask(() => {
        if (this.busy === 0 && !this.evalScheduled) {
          const w = this.idleWaiters;
          this.idleWaiters = [];
          for (const f of w) f();
        }
      });
    }
  }

  private ingestOwn(d: StoredMsg): void {
    let soul: string;
    try {
      soul = soulOf(d.env, this.o.lobbyCode);
    } catch {
      return;
    }
    if (soul === this.setupSoul || soul === this.playSoul) this.ingest(soul, d.key, d.value);
  }

  private send(d: StoredMsg): void {
    if (this.stopped) return;
    let soul: string;
    try {
      soul = soulOf(d.env, this.o.lobbyCode);
    } catch {
      return;
    }
    this.o.transport.publish(soul, d.key, d.value).catch(() => undefined);
  }

  /** The build context; only a cancel may be built without secrets (§3.10). */
  private buildCtx(slot: string, ev?: GameEval): BuildCtx {
    if (this.o.secrets === null && slot !== 'cancel') throw new Error('This browser lost the secret keys for this game');
    const e = ev ?? this.ev ?? this.evaluateNow();
    return {
      config: this.config, configId: this.configId, lobbyId: this.o.lobbyId, seat: this.seat, me: this.o.signer.pub,
      ev: { ...e, jobs: [] }, secrets: this.o.secrets, priv: this.priv, now: this.o.now(),
    };
  }

  /** Runs `fn` under the driver-wide publish mutex (FIFO). */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.lockTail;
    let release: () => void = () => undefined;
    this.lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await prior;
      return await fn();
    } finally {
      release();
    }
  }

  /** publish(slot, build) of §3.9 under the driver mutex; concurrent calls for one slot share one run. */
  private publish(slot: string, mk: (ctx: BuildCtx) => BuildTask): Promise<StoredMsg | null> {
    const prior = this.slotLocks.get(slot);
    if (prior !== undefined) return prior;
    this.busy++;
    const p = this.withLock(() => this.publishLocked(slot, mk)).finally(() => {
      this.slotLocks.delete(slot);
      this.done();
    });
    this.slotLocks.set(slot, p);
    return p;
  }

  /**
   * publish(slot, build) of §3.9, with the driver mutex held: re-put the
   * journaled value if the slot exists, else build, sign, journal (atomically,
   * keeping a value another driver of this seat journaled first) and put. A
   * step message is never journaled once a cancel is (§3.7 rule 2). `ev`: the
   * evaluation to build against (default: the latest).
   */
  private async publishLocked(slot: string, mk: (ctx: BuildCtx) => BuildTask, ev?: GameEval): Promise<StoredMsg | null> {
    this.busy++;
    try {
      const existing = await this.o.journal.get(this.scope, slot);
      if (this.stopped) return null;
      if (existing !== null) return this.resend(slot, existing);
      const stepped = slot !== 'cancel' && slot !== 'reveal' && slot !== 'log';
      if (stepped && await this.o.journal.get(this.scope, 'cancel') !== null) return null;
      const ctx = this.buildCtx(slot, ev);
      if (stepped && ctx.ev.pending?.step.id !== slot) throw new StaleStepError(`${slot} is no longer pending`);
      const raw = await this.o.crypto.prove(mk(ctx));
      if (this.stopped) return null;
      if (!isEnvelopeLike(raw)) throw new Error('build returned no envelope');
      const env = parseEnvelope(raw);
      if (stepped && env.step !== slot) throw new Error(`built a message for ${env.step} in slot ${slot}`);
      const enc = encodeEnvelope(env, this.o.signer);
      if (stepped && await this.o.journal.get(this.scope, 'cancel') !== null) return null;
      if (this.stopped) return null;
      const stored = await this.o.journal.putIfAbsent(this.scope, slot, enc.value);
      if (stored !== enc.value) return this.resend(slot, stored);
      if (env.type === 'key') this.keyed = true;
      const d: StoredMsg = { msgId: enc.msgId, env: parseEnvelope(JSON.parse(JSON.stringify(env))), value: enc.value, key: enc.key };
      primeDecoded(d);
      this.ingestOwn(d);
      this.send(d);
      return d;
    } finally {
      this.done();
    }
  }

  /** Ingests and re-puts a journaled value. */
  private resend(slot: string, value: string): StoredMsg {
    const d = decodeCached(value);
    if ('error' in d) throw new Error(`corrupt journal entry ${slot}: ${d.error}`);
    if (d.env.type === 'key') this.keyed = true;
    this.ingestOwn(d);
    this.send(d);
    return d;
  }

  private scheduleEval(): void {
    if (this.stopped || this.evalScheduled) return;
    this.evalScheduled = true;
    this.busy++;
    queueMicrotask(() => {
      this.evalScheduled = false;
      try {
        if (!this.stopped) this.afterEval(this.evaluateNow());
      } catch (e) {
        this.o.onError?.(e);
      } finally {
        this.done();
      }
    });
  }

  private evaluateNow(): GameEval {
    const ev = reduceGame({
      config: this.config, configId: this.configId, lobbyId: this.o.lobbyId, msgs: this.msgs, verdicts: this.verdicts,
      conflictingConfigs: this.conflicting, configAuthor: this.o.configAuthor,
    });
    this.ev = ev;
    return ev;
  }

  private afterEval(ev: GameEval): void {
    // Verification jobs.
    const todo = ev.jobs.filter((j) => !this.verdicts.has(j.id) && !this.inflight.has(j.id));
    if (todo.length > 0) {
      for (const j of todo) this.inflight.add(j.id);
      this.busy++;
      this.o.crypto.verify(todo).then((vs) => {
        todo.forEach((j, i) => {
          const v = vs[i];
          if (v !== undefined) this.verdicts.set(j.id, v.ok ? { ok: true } : { ok: false, reason: v.reason ?? 'invalid' });
        });
      }).catch((e: unknown) => this.o.onError?.(e)).finally(() => {
        for (const j of todo) this.inflight.delete(j.id);
        this.scheduleEval();
        this.done();
      });
    }
    // Private view (own card after deal, sight after otS).
    if (this.o.secrets !== null && (this.priv === null || !this.priv.sightKnown)) {
      try {
        const p = derivePrivate(this.config, ev, this.seat, this.o.secrets);
        if (p !== null) this.priv = p;
      } catch (e) {
        this.o.onError?.(e);
      }
    }
    this.outcomeValue = computeOutcome(this.config, ev, this.msgs);
    if (ev.terminal !== null && this.terminalAt === null) this.terminalAt = this.o.now();
    this.emitView(ev);
    this.o.onEval?.(ev);
    void this.act();
  }

  private emitView(ev: GameEval): void {
    const game = projectGame(this.config, ev, this.outcomeValue);
    if (game.state === 'ACTIVE' && (this.priv === null || !this.priv.sightKnown)) {
      // ACTIVE is projected only once this seat's role and sees are derived (§11.3).
      const n = this.config.seats.length;
      game.state = 'INIT';
      game.phase = '';
      game.setup = { stage: 'sight', done: n, total: n, waitingFor: [] };
    }
    const view: SeatView = {
      game, role: projectRole(this.config, this.priv), progress: projectProgress(this.config, ev),
      pending: ev.pending, terminal: ev.terminal !== null, outcome: this.outcomeValue,
    };
    const json = JSON.stringify(view);
    this.viewValue = view;
    if (json === this.lastViewJson) return;
    this.lastViewJson = json;
    this.o.onView(view);
  }

  private async act(): Promise<void> {
    if (this.acting) {
      this.actAgain = true;
      return;
    }
    this.acting = true;
    this.busy++;
    try {
      do {
        this.actAgain = false;
        try {
          await this.actOnce();
        } catch (e) {
          // A stale automatic decision is retried on the next evaluation; anything else is reported.
          if (!(e instanceof StaleStepError)) this.o.onError?.(e);
        }
      } while (this.actAgain && !this.stopped);
    } finally {
      this.acting = false;
      this.done();
    }
  }

  /** §7.7: the automatic action the current evaluation calls for, if any. */
  private async actOnce(): Promise<void> {
    const ev = this.ev;
    if (ev === null || this.stopped || this.o.secrets === null) return;
    if (ev.terminal !== null) {
      if (!this.keyed && await this.o.journal.get(this.scope, 'key') === null) return;
      this.keyed = true;
      if (await this.o.journal.get(this.scope, 'reveal') === null) {
        for (const id of ev.terminal.basis) {
          const m = this.known(id);
          if (m !== undefined) this.send(m);
        }
      }
      await this.publish('reveal', (ctx) => ({ kind: 'build', fn: 'reveal', ctx }));
      const out = this.outcomeValue;
      if (out !== null && out.state !== 'CANCELED') {
        const late = this.terminalAt !== null && this.o.now() - this.terminalAt >= LOG_DELAY_MS;
        if (out.final || late) {
          const lobbyCode = this.o.lobbyCode;
          const createdAt = this.o.createdAt;
          await this.publish('log', (ctx) => ({ kind: 'build', fn: 'log', ctx, outcome: out, lobbyCode, createdAt }));
        }
      }
      return;
    }
    if (ev.pendingReveals.length > 0 || this.cancelling) return;
    if (await this.o.journal.get(this.scope, 'cancel') !== null) return;
    const p = ev.pending;
    if (p === null || !p.gateOpen || !p.missing.includes(this.seat)) return;
    if (p.step.kind === 'setup' || p.step.kind === 'automatic') await this.publishAutomatic(p.step);
  }

  /** This seat's message for an automatic or setup step; `locked`: the caller holds the driver mutex. */
  private async publishAutomatic(step: StepDef, locked = false): Promise<void> {
    const pub = (mk: (ctx: BuildCtx) => BuildTask): Promise<StoredMsg | null> =>
      (locked ? this.publishLocked(step.id, mk) : this.publish(step.id, mk));
    switch (step.type) {
      case 'key':
        await pub((ctx) => ({ kind: 'build', fn: 'key', ctx }));
        return;
      case 'shuffle':
        await pub((ctx) => ({ kind: 'build', fn: 'shuffle', ctx }));
        return;
      case 'deal':
        await pub((ctx) => ({ kind: 'build', fn: 'deal', ctx }));
        return;
      case 'ot.recv':
        if (this.priv === null) return;
        await pub((ctx) => ({ kind: 'build', fn: 'otRecv', ctx }));
        return;
      case 'ot.send':
        if (this.priv === null) return;
        await pub((ctx) => ({ kind: 'build', fn: 'otSend', ctx }));
        return;
      case 'vote.reveal': {
        const commitValue = await this.o.journal.get(this.scope, step.id.replace(/^vr\//, 'vc/'));
        if (commitValue === null) return;
        const d = decodeCached(commitValue);
        if ('error' in d || d.env.type !== 'vote.commit') return;
        const commitEnv = d.env as Envelope<'vote.commit'>;
        await pub((ctx) => ({ kind: 'build', fn: 'voteReveal', ctx, commitEnv }));
        return;
      }
      case 'tally':
        await pub((ctx) => ({ kind: 'build', fn: 'tally', ctx }));
        return;
      default:
        return;
    }
  }
}

/**
 * The current game of a lobby (§4.6.4): once step `key` of a config completed,
 * that game stays current until it is terminal, whatever later roster forks do
 * (several started non-terminal games: the lowest configId); otherwise the
 * lobby reducer's current config. `games` describes the configs this device
 * evaluates.
 */
export function selectCurrentGame(state: LobbyState, games: readonly { configId: Hex32; keyComplete: boolean; terminal: boolean }[]): Hex32 | null {
  const running = games.filter((g) => g.keyComplete && !g.terminal).map((g) => g.configId).sort();
  if (running.length > 0) return running[0];
  return state.currentConfig?.configId ?? null;
}

/**
 * §4.6.3: a seat's accepted config is superseded (terminal for this device,
 * nothing published or revealed) when it is no longer the lobby's current
 * game while its `key` step is incomplete.
 */
export function isSuperseded(current: Hex32 | null, configId: Hex32, keyComplete: boolean): boolean {
  return !keyComplete && current !== configId;
}
