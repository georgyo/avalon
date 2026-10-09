/**
 * P2PSession: the composition root of the client runtime (docs/p2p-protocol.md
 * §3.9-3.10, §4, §7, §11.2, §11.3), used by client/src/avalon.ts.
 *
 * It owns the IndexedDB store, the identity, the single-writer lock, the GUN
 * transport with its watchdog, presence, the worker pool, the lobby client and
 * one SeatDriver per game this device takes part in, and projects them to the
 * plain JSON snapshots the UI consumes (`LobbyData`, `RoleDoc`, status).
 *
 * Only the holder of the Web Lock runs drivers (signs or publishes); another
 * tab is READ_ONLY_OTHER_TAB until `useHere()`.
 */
import { b64uDecode, b64uEncode, randomBytes } from '@avalon/common/crypto';
import {
  checkConfig, computeUserStats, conflictingConfigs, decodeCached, emptyGameData, gameSoul, isSuperseded, lobbySoul,
  memberOf, selectCurrentGame, soulOf, SeatDriver, validateName,
  type CancelReason, type CryptoBackend, type GameConfig, type GameEval, type Hex32, type HistoryEntry,
  type LobbyCandidate, type LobbyData, type LobbyState, type LobbyUser, type Pub, type RoleDoc, type SeatView,
  type SetupProgress, type StoredMsg, type Transport, type UserStats, type Verdict, type VerifyJob, type ProveTask,
} from '@avalon/common/protocol';
import { Clock, relayInfo, type FetchLike, type GunHandle } from './gun.ts';
import { every, errorMessage, Listeners, realTimers, type EventSource, type Timers, type VisibilitySource } from './env.ts';
import { GunTransport } from './gunTransport.ts';
import { loadIdentity, loadOrCreateIdentity, resetIdentity as clearIdentity, type Identity } from './identity.ts';
import { acquireDriverLock, type LockManagerLike, type LockState } from './locks.ts';
import { DISCOVERY_MS, LobbyClient, MAX_CODE_ATTEMPTS, PROBE_MS, discover, drawCode } from './lobbyClient.ts';
import { Presence, type WakeLockLike } from './presence.ts';
import { MemoryKV, openStore, type GameRecord, type KV, type ProfileRecord, type Store } from './store.ts';
import { Watchdog } from './watchdog.ts';
import { WorkerPool } from './workerPool.ts';

// ---------------------------------------------------------------- public types (§11.2)

export type SessionStatus =
  | { kind: 'CONNECTING' | 'LOBBY' | 'ACTIVE' | 'ENDED' | 'LOST_SECRETS' | 'READ_ONLY_OTHER_TAB' }
  | { kind: 'SYNCING'; percent: number } | { kind: 'STARTING' | 'SETUP'; progress: SetupProgress }
  | { kind: 'STALLED'; seats: string[]; sinceMs: number } | { kind: 'ENDING'; revealed: number; total: number };

export interface LocalProfile { uid: Pub; name: string | null; lobby: string | null }

export interface SessionOptions {
  /** Base URL of the relay (default: the page origin); GUN connects to `<relayUrl>/gun`. */
  relayUrl?: string;
  /** Storage backend (default: IndexedDB). */
  kv?: KV;
  /** Web Locks (default navigator.locks; null: no other tabs). */
  locks?: LockManagerLike | null;
  lockName?: string;
  /** Crypto backend (default: a WorkerPool over crypto.worker.ts). */
  crypto?: CryptoBackend;
  fetch?: FetchLike;
  /** GUN handle factory (tests). */
  createHandle?: (relayUrl: string) => GunHandle;
  timers?: Timers;
  window?: EventSource | null;
  document?: VisibilitySource | null;
  wakeLock?: WakeLockLike | null;
  /** Join discovery and code probe windows (Appendix B: 3 s / 1.5 s). */
  discoveryMs?: number;
  probeMs?: number;
  /** Install the clock drift into Gun.state (default true; tests with several sessions in one process pass false). */
  gunClock?: boolean;
}

// ---------------------------------------------------------------- constants (§7.8, Appendix B)

const TICK_MS = 1000;
const DRIVER_TICK_MS = 5000;
const REASK_AFTER_MS = 10000;
const REASK_EVERY_MS = 15000;
const REPUT_EVERY_MS = 30000;
const AUTOMATIC_STALL_MS = 2000;
const HUMAN_STALL_MS = 10000;
const ENDING_MAX_MS = 60000;
const KEEP_ENDED_MS = 10 * 60 * 1000;
/** How long discovery waits for the candidates' admin heartbeats. */
const PRESENCE_WAIT_MS = 1000;

// ---------------------------------------------------------------- helpers

/** Emits the current value on subscription, then every change (copies, so the UI cannot mutate internals). */
class Emitter<T> {
  private readonly listeners = new Listeners<T>();
  constructor(private readonly current: () => T) {}
  on(cb: (v: T) => void): () => void {
    const off = this.listeners.add(cb);
    cb(clone(this.current()));
    return off;
  }
  emit(): void {
    this.listeners.emit(clone(this.current()));
  }
}

function clone<T>(v: T): T {
  return v === null || v === undefined ? v : structuredClone(v);
}

/** Verdict cache that persists every verdict the driver records (§7.5: keyed by msgId, cached in IndexedDB). */
class PersistentVerdicts extends Map<Hex32, Verdict> {
  persist: ((id: Hex32, v: Verdict) => void) | null = null;
  /** Loads a cached verdict without persisting it again. */
  preload(id: Hex32, v: Verdict): void {
    super.set(id, v);
  }
  override set(id: Hex32, v: Verdict): this {
    const had = super.get(id);
    super.set(id, v);
    if (had === undefined || had.ok !== v.ok) this.persist?.(id, v);
    return this;
  }
}

/** Counts verification work (SYNCING percent). */
class CountingCrypto implements CryptoBackend {
  submitted = 0;
  completed = 0;
  constructor(private readonly inner: CryptoBackend) {}
  async verify(jobs: VerifyJob[]): Promise<Verdict[]> {
    this.submitted += jobs.length;
    try {
      return await this.inner.verify(jobs);
    } finally {
      this.completed += jobs.length;
    }
  }
  prove(task: ProveTask): Promise<unknown> {
    return this.inner.prove(task);
  }
}

type RuntimeMode = 'seat' | 'lost' | 'observer';

interface GameRuntime {
  configId: Hex32;
  config: GameConfig;
  configMsg: StoredMsg;
  lobbyId: Hex32;
  lobbyCode: string;
  seat: number;
  mode: RuntimeMode;
  refusal: string | null;
  record: GameRecord | null;
  driver: SeatDriver;
  crypto: CountingCrypto;
  view: SeatView | null;
  ev: GameEval | null;
  pendingKey: string | null;
  pendingSince: number | null;
  terminalAt: number | null;
  terminalWall: number | null;
  recovering: boolean;
  abandoned: boolean;
  lastHistoryJson: string;
  stopped: boolean;
  /** msgIds of the conflicting configs last handed to the driver. */
  conflictKey: string;
}

function keyComplete(ev: GameEval | null): boolean {
  return ev !== null && ev.chain.some((c) => c.stepId === 'key');
}

function isTerminal(rt: GameRuntime): boolean {
  return rt.ev?.terminal != null;
}

function configOf(m: StoredMsg): GameConfig | null {
  return m.env.type === 'lobby.config' ? (m.env.body as GameConfig) : null;
}

// ---------------------------------------------------------------- the session

export class P2PSession {
  private readonly o: SessionOptions;
  private readonly timers: Timers;
  private readonly relayUrl: string;
  private store!: Store;
  private lock!: LockState;
  private readonly clock: Clock;
  readonly transport: GunTransport;
  private readonly watchdog: Watchdog;
  private readonly presence: Presence;
  private readonly cryptoBackend: CryptoBackend;
  private identity: Identity | null = null;
  private profileRec: ProfileRecord = { name: null, lobbyCode: null, lobbyId: null };
  private lobby: LobbyClient | null = null;
  private lobbyState: LobbyState | null = null;
  private lobbySynced = false;
  private memberSeq = -1;
  private joining: LobbyClient | null = null;
  private readonly runtimes = new Map<Hex32, GameRuntime>();
  private readonly accepting = new Set<Hex32>();
  private readonly verdicts = new PersistentVerdicts();
  private readonly recorded = new Set<Hex32>();
  private active = false;
  private activating: Promise<void> | null = null;
  private storeError = false;
  private everConnected = false;
  /** Configs this device dismissed (abandoned, superseded, conflicting record): not "active" for the lobby. */
  private readonly dismissed = new Set<Hex32>();
  private lastStatusKey = '';
  private closed = false;
  private readonly stops: (() => void)[] = [];
  private lastReask = 0;
  private lastReput = 0;
  private readonly profileEmitter = new Emitter<LocalProfile | null>(() => this.profile);
  private readonly lobbyEmitter = new Emitter<LobbyData | null>(() => this.lobbyData());
  private readonly roleEmitter = new Emitter<RoleDoc | null>(() => this.roleDoc());
  private readonly statusEmitter = new Emitter<SessionStatus>(() => this.status);
  private lastLobbyJson = '';
  private lastRoleJson = '';
  private lastProfileJson = '';
  /** Errors from drivers (diagnostics, tests). */
  readonly errors: string[] = [];

  private constructor(o: SessionOptions) {
    this.o = o;
    this.timers = o.timers ?? realTimers;
    this.relayUrl = o.relayUrl ?? (typeof location !== 'undefined' ? location.origin : 'http://127.0.0.1:8001');
    this.clock = new Clock(o.gunClock !== false);
    this.cryptoBackend = o.crypto ?? new WorkerPool();
    this.transport = new GunTransport({ relayUrl: this.relayUrl, createHandle: o.createHandle, timers: this.timers });
    const win = o.window === undefined ? (typeof window !== 'undefined' ? window : null) : o.window;
    const doc = o.document === undefined ? (typeof document !== 'undefined' ? document : null) : o.document;
    this.watchdog = new Watchdog({
      target: this.transport,
      relayInfo: () => relayInfo(this.relayUrl, o.fetch),
      onClock: (info) => this.clock.sync(info),
      onHi: () => this.onHi(),
      onNewBoot: () => this.onNewBoot(),
      onConnectedChange: (up) => {
        if (up) this.everConnected = true;
        this.refreshStatus();
      },
      timers: this.timers,
      window: win,
      document: doc,
    });
    this.presence = new Presence({
      transport: this.transport, timers: this.timers, document: doc, wakeLock: o.wakeLock,
      seqStart: Math.floor(Date.now() / 1000),
    });
    if (doc !== null) {
      const vis = (): void => {
        if (doc.visibilityState === 'visible') for (const rt of this.runtimes.values()) rt.driver.tick();
      };
      doc.addEventListener('visibilitychange', vis);
      this.stops.push(() => doc.removeEventListener('visibilitychange', vis));
    }
  }

  /** Opens the session: storage, lock, identity, connection; resumes the lobby and games (§3.10). */
  static async open(o: SessionOptions = {}): Promise<P2PSession> {
    const s = new P2PSession(o);
    try {
      s.store = await openStore({ kv: o.kv, onError: (e) => s.onStoreError(e) });
    } catch (e) {
      s.storeError = true;
      s.errors.push('store: ' + errorMessage(e));
      s.store = await openStore({ kv: new MemoryKV() });
    }
    s.verdicts.persist = (k, v) => {
      s.store.verdicts.put(k, v).catch(() => undefined);
    };
    s.lock = await acquireDriverLock({ locks: o.locks, name: o.lockName });
    s.lock.onChange((held) => {
      if (held) void s.activate();
      else s.deactivate();
      s.refreshStatus();
    });
    s.watchdog.start();
    s.stops.push(every(s.timers, TICK_MS, () => s.tick()));
    if (s.transport.connected()) s.everConnected = true;
    s.transport.onHi(() => {
      s.everConnected = true;
      s.refreshStatus();
    });
    if (s.lock.held) {
      await s.activate();
    } else {
      // Read-only tab: show who is logged in (reading the store publishes nothing).
      try {
        s.identity = await loadIdentity(s.store);
        s.profileRec = await s.store.profile.get();
      } catch (e) {
        s.onStoreError(e);
      }
    }
    s.refreshStatus();
    return s;
  }

  // ------------------------------------------------------------ getters and events

  get profile(): LocalProfile | null {
    if (this.identity === null) return null;
    return { uid: this.identity.pub, name: this.profileRec.name, lobby: this.profileRec.lobbyCode };
  }

  get status(): SessionStatus {
    return clone(this.computeStatus());
  }

  get connected(): boolean {
    return this.transport.connected();
  }

  onProfile(cb: (p: LocalProfile | null) => void): () => void {
    return this.profileEmitter.on(cb);
  }

  onLobby(cb: (l: LobbyData | null) => void): () => void {
    return this.lobbyEmitter.on(cb);
  }

  onRole(cb: (r: RoleDoc | null) => void): () => void {
    return this.roleEmitter.on(cb);
  }

  onStatus(cb: (s: SessionStatus) => void): () => void {
    return this.statusEmitter.on(cb);
  }

  // ------------------------------------------------------------ identity

  async createIdentity(): Promise<void> {
    this.requireWriter();
    if (this.identity !== null) return;
    this.identity = await loadOrCreateIdentity(this.store, () => this.clock.now());
    this.startIdentity();
    this.emitProfile();
    this.refreshStatus();
  }

  async resetIdentity(): Promise<void> {
    this.requireWriter();
    for (const rt of this.runtimes.values()) {
      if (rt.mode === 'seat' && !isTerminal(rt) && !rt.abandoned) throw new Error('Cannot log out during a game');
    }
    this.stopLobby();
    for (const rt of [...this.runtimes.values()]) this.dropRuntime(rt);
    this.presence.stop();
    await clearIdentity(this.store);
    this.identity = null;
    this.profileRec = { name: null, lobbyCode: null, lobbyId: null };
    this.transport.forgetUser();
    this.transport.rebuild();
    this.emitAll();
  }

  // ------------------------------------------------------------ lobby actions

  async createLobby(name: string): Promise<{ lobby: string }> {
    this.requireIdentity();
    const bad = validateName(name);
    if (bad !== null) throw new Error(bad);
    if (this.lobby !== null) throw new Error('Already in a lobby');
    let code = drawCode();
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const found = await discover(this.transport, code, { timeoutMs: this.o.probeMs ?? PROBE_MS, timers: this.timers });
      if (found.candidates.length === 0 || !(await this.anyLive(found.candidates))) break;
      if (attempt < MAX_CODE_ATTEMPTS - 1) code = drawCode();
    }
    this.requireWriter();
    if (this.lobby !== null) throw new Error('Already in a lobby');
    const client = this.makeLobbyClient(code, null);
    this.lobby = client;
    this.lobbyState = null;
    this.lobbySynced = true;
    this.memberSeq = -1;
    client.start();
    let lobbyId: Hex32;
    try {
      lobbyId = await client.driver.create(name);
    } catch (e) {
      this.stopLobby();
      throw e;
    }
    this.profileRec = { name, lobbyCode: code, lobbyId };
    await this.store.profile.put(this.profileRec);
    this.memberSeq = 1;
    this.presence.setState({ lobby: lobbyId });
    this.emitAll();
    return { lobby: code };
  }

  async findLobbies(code: string): Promise<LobbyCandidate[]> {
    const c = code.trim().toUpperCase();
    if (!/^[A-HJ-NP-TV-Z]{4}$/.test(c)) return [];
    const found = await discover(this.transport, c, { timeoutMs: this.o.discoveryMs ?? DISCOVERY_MS, timers: this.timers });
    // admins' presence: a lobby is live if its admin's latest heartbeat names it (§4.3)
    this.presence.watch(this.watchedPubs(found.candidates.map((x) => x.adminPub)));
    return found.candidates;
  }

  async joinLobby(name: string, code: string, lobbyId?: Hex32): Promise<{ lobby: string }> {
    this.requireIdentity();
    const bad = validateName(name);
    if (bad !== null) throw new Error(bad);
    if (this.lobby !== null) throw new Error('Already in a lobby');
    const c = code.trim().toUpperCase();
    const found = await discover(this.transport, c, { timeoutMs: this.o.discoveryMs ?? DISCOVERY_MS, timers: this.timers });
    let cands = found.candidates;
    if (lobbyId !== undefined && lobbyId !== '') cands = cands.filter((x) => x.lobbyId.startsWith(lobbyId.toLowerCase()));
    if (cands.length === 0) throw new Error(`Lobby ${c} not found`);
    if (cands.length > 1) {
      await this.anyLive(cands);
      const live = cands.filter((x) => this.isLive(x));
      if (live.length !== 1) throw new Error(`Several lobbies use code ${c}; choose one`);
      cands = live;
    }
    const cand = cands[0];
    this.requireWriter();
    if (this.lobby !== null || this.joining !== null) throw new Error('Already in a lobby');
    const client = this.makeLobbyClient(c, cand.lobbyId);
    this.joining = client;
    client.start();
    client.ingest(found.msgs);
    try {
      await client.driver.join(name);
    } catch (e) {
      client.stop();
      if (this.joining === client) this.joining = null;
      throw e;
    }
    if (this.joining !== client) {
      client.stop();
      throw new Error('Join canceled');
    }
    this.joining = null;
    this.lobby = client;
    this.lobbyState = client.state;
    this.lobbySynced = true;
    this.memberSeq = client.state?.head.seq ?? -1;
    this.profileRec = { name, lobbyCode: c, lobbyId: cand.lobbyId };
    await this.store.profile.put(this.profileRec);
    this.presence.setState({ lobby: cand.lobbyId });
    if (client.state !== null) this.onLobbyState(client, client.state);
    this.emitAll();
    return { lobby: c };
  }

  async leaveLobby(): Promise<void> {
    this.requireWriter();
    const client = this.lobby;
    if (client === null) {
      if (this.joining !== null) {
        const j = this.joining;
        this.joining = null;
        await j.driver.leave().catch(() => undefined);
        j.stop();
        return;
      }
      throw new Error('Not in a lobby');
    }
    const rt = this.currentRuntime();
    if (rt !== null && !isTerminal(rt) && !rt.abandoned && (rt.mode === 'seat' || rt.mode === 'lost')) {
      // §4.5: cancel first, except during the assassination and at a rule-2a mt/m with the own tally journaled.
      try {
        await rt.driver.cancel(rt.mode === 'lost' ? 'lost' : 'leave');
      } catch {
        // the excepted cases: only leave
      }
    }
    try {
      await client.driver.leave();
    } finally {
      this.disconnectLobby();
    }
  }

  async kickPlayer(name: string): Promise<void> {
    this.requireWriter();
    const client = this.requireLobby();
    const s = this.requireLobbyState();
    if (s.head.admin !== this.identity?.pub) throw new Error('Only the admin can kick players');
    if (this.gameActive()) throw new Error('Cancel game first');
    const m = s.head.members.find((x) => x.name === name);
    if (m === undefined) throw new Error('No such player ' + name);
    if (m.pub === this.identity.pub) throw new Error("Can't kick yourself");
    await client.driver.kick(m.pub);
  }

  async takeOverAdmin(): Promise<void> {
    this.requireWriter();
    const client = this.requireLobby();
    const s = this.requireLobbyState();
    if (s.head.admin === this.identity?.pub) throw new Error('You are already the admin');
    await client.driver.takeOver();
  }

  async startGame(playerList: string[], roles: string[], options: { inGameLog: boolean }): Promise<void> {
    this.requireWriter();
    const client = this.requireLobby();
    const s = this.requireLobbyState();
    if (s.head.admin !== this.identity?.pub) throw new Error('Only the admin can start the game');
    if (this.gameActive()) throw new Error('Game already in progress');
    if (playerList.length < 5) throw new Error('Need at least 5 players');
    if (playerList.length > 10) throw new Error('Cannot start game with more than 10 players');
    const names = s.head.members.map((m) => m.name);
    if (playerList.length !== names.length || !playerList.every((n) => names.includes(n)) || new Set(playerList).size !== playerList.length) {
      throw new Error('Bad player list: ' + [...playerList].sort().join(',') + '. In lobby: ' + [...names].sort().join(','));
    }
    const seats = playerList.map((name) => {
      const m = s.head.members.find((x) => x.name === name);
      if (m === undefined) throw new Error('No such player ' + name);
      return { pub: m.pub, name: m.name };
    });
    await client.driver.startGame(seats, roles, options);
    this.syncGames();
  }

  // ------------------------------------------------------------ game actions

  async cancelGame(): Promise<void> {
    this.requireWriter();
    const rt = this.currentRuntime();
    if (rt === null || isTerminal(rt) || rt.abandoned) throw new Error('No game in progress');
    let reason: CancelReason = 'cancel';
    if (rt.mode === 'lost') reason = 'lost';
    else if (rt.mode === 'observer') throw new Error(rt.refusal ?? 'You are not playing in this game');
    else if (rt.ev?.pending?.step.id === 'key') reason = 'abort';
    await rt.driver.cancel(reason);
  }

  async abandonGame(): Promise<void> {
    this.requireWriter();
    const rt = this.currentRuntime();
    if (rt === null || isTerminal(rt)) throw new Error('No game in progress');
    rt.abandoned = true;
    this.dismissed.add(rt.configId);
    if (rt.record !== null) {
      rt.record = { ...rt.record, status: 'abandoned', endedAt: this.clock.now() };
      await this.store.games.put(rt.record);
    }
    rt.driver.stop();
    rt.stopped = true;
    this.presence.setWakeLock(false);
    this.updateGameActive();
    this.emitAll();
  }

  async proposeTeam(names: string[]): Promise<void> {
    const rt = this.requirePlaying();
    const seats = names.map((n) => {
      const j = rt.config.seats.findIndex((s) => s.name === n);
      if (j < 0) throw new Error('Bad team: ' + names.join(','));
      return j;
    });
    await rt.driver.propose(seats);
  }

  async voteTeam(approve: boolean): Promise<void> {
    await this.requirePlaying().driver.vote(approve);
  }

  async doMission(success: boolean): Promise<void> {
    await this.requirePlaying().driver.mission(success);
  }

  async assassinate(name: string): Promise<void> {
    const rt = this.requirePlaying();
    const j = rt.config.seats.findIndex((s) => s.name === name);
    if (j < 0) throw new Error('Invalid assassination target');
    await rt.driver.assassinate(j);
  }

  async useHere(): Promise<void> {
    if (this.lock.held) return;
    await this.lock.steal();
    await this.activate();
  }

  async userStats(): Promise<UserStats> {
    return computeUserStats(await this.store.history.all());
  }

  /** Stops everything (tests; page unload). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.deactivate();
    this.watchdog.stop();
    for (const s of this.stops.splice(0)) s();
    this.lock.release();
    this.transport.close();
    if (this.cryptoBackend instanceof WorkerPool) this.cryptoBackend.terminate();
    this.store.kv.close?.();
  }

  // ------------------------------------------------------------ diagnostics (tests)

  /** The seat driver of the lobby's current game, if any. */
  get currentDriver(): SeatDriver | null {
    return this.currentRuntime()?.driver ?? null;
  }

  get lobbyStateSnapshot(): LobbyState | null {
    return this.lobbyState;
  }

  /** The watchdog's reconnect attempts. */
  get reconnects(): number {
    return this.watchdog.reconnects;
  }

  // ------------------------------------------------------------ activation (§3.10)

  private activate(): Promise<void> {
    if (this.closed || !this.lock.held) return Promise.resolve();
    if (this.active) return Promise.resolve();
    if (this.activating !== null) return this.activating;
    const p = (async () => {
      try {
        await this.recover();
        this.active = true;
      } catch (e) {
        this.onStoreError(e);
      } finally {
        this.activating = null;
        this.emitAll();
      }
    })();
    this.activating = p;
    return p;
  }

  /** Startup recovery (§3.10): identity, profile, active games, lobby; cached transcripts; republish. */
  private async recover(): Promise<void> {
    this.identity = await loadIdentity(this.store);
    this.profileRec = await this.store.profile.get();
    if (this.identity === null) {
      this.emitAll();
      return;
    }
    this.startIdentity();
    const records = await this.store.games.all();
    for (const rec of records) {
      if (rec.status !== 'active' && rec.status !== 'lost') continue;
      const cfg = await this.store.transcript.get(rec.configId);
      if (cfg === null) continue;
      const d = decodeCached(cfg.value, cfg.key);
      if ('error' in d || configOf(d) === null) continue;
      await this.startRuntime(d, rec.lobbyCode ?? this.profileRec.lobbyCode ?? '', rec);
    }
    const { lobbyCode, lobbyId } = this.profileRec;
    if (lobbyCode !== null && lobbyId !== null) {
      const client = this.makeLobbyClient(lobbyCode, lobbyId);
      this.lobby = client;
      this.lobbyState = null;
      this.lobbySynced = false;
      this.memberSeq = -1;
      this.presence.setState({ lobby: lobbyId });
      const cached = await this.store.transcript.forScope(lobbyId);
      client.start();
      client.ingest(cached);
      void this.transport.syncedOk(client.soul).then((ok) => {
        if (!ok || this.lobby !== client) return;
        this.lobbySynced = true;
        if (client.state !== null) this.onLobbyState(client, client.state);
      });
    }
    this.emitAll();
  }

  private deactivate(): void {
    this.active = false;
    if (this.lobby !== null) this.lobby.stop();
    if (this.joining !== null) this.joining.stop();
    this.lobby = null;
    this.joining = null;
    this.lobbyState = null;
    for (const rt of [...this.runtimes.values()]) {
      rt.driver.stop();
      rt.stopped = true;
    }
    this.runtimes.clear();
    this.accepting.clear();
    this.presence.stop();
    this.emitAll();
  }

  private startIdentity(): void {
    const id = this.identity;
    if (id === null) return;
    this.transport.auth(id.pair).catch((e: unknown) => this.errors.push('auth: ' + errorMessage(e)));
    this.presence.start();
  }

  private onStoreError(e: unknown): void {
    this.storeError = true;
    this.errors.push('store: ' + errorMessage(e));
    this.refreshStatus();
  }

  // ------------------------------------------------------------ lobby wiring

  private makeLobbyClient(code: string, lobbyId: Hex32 | null): LobbyClient {
    const id = this.requireIdentity();
    const client: LobbyClient = new LobbyClient({
      code, lobbyId, signer: id.signer, transport: this.transport, journal: this.store.journal, now: () => this.clock.now(),
      onState: (s) => this.onLobbyState(client, s),
      onMessage: (m, soul) => this.record(m, soul, m.env.lobby === '' ? m.msgId : m.env.lobby),
    });
    return client;
  }

  private onLobbyState(client: LobbyClient, s: LobbyState): void {
    if (client !== this.lobby || this.identity === null) return;
    this.lobbyState = s;
    const me = this.identity.pub;
    const member = memberOf(s, me);
    if (member !== undefined && !s.leaves.has(me) && !s.head.closed) {
      this.memberSeq = Math.max(this.memberSeq, s.head.seq);
    } else {
      // Kicked, left elsewhere, or the lobby closed (§4.5): only on evidence newer than our membership.
      const removed = s.head.closed || s.leaves.has(me) || (this.memberSeq >= 0 && s.head.seq > this.memberSeq)
        || (this.memberSeq < 0 && this.lobbySynced);
      if (removed) {
        this.disconnectLobby();
        return;
      }
    }
    this.presence.watch(this.watchedPubs(s.head.members.map((m) => m.pub)));
    this.syncGames();
    this.emitAll();
  }

  private watchedPubs(extra: string[]): string[] {
    const out: string[] = [];
    for (const m of this.lobbyState?.head.members ?? []) out.push(m.pub);
    for (const p of extra) if (!out.includes(p)) out.push(p);
    return out;
  }

  /** Watches the candidates' admins and waits briefly for their heartbeats; true if any candidate is live. */
  private async anyLive(cands: readonly LobbyCandidate[]): Promise<boolean> {
    this.presence.watch(this.watchedPubs(cands.map((x) => x.adminPub)));
    for (let waited = 0; waited < PRESENCE_WAIT_MS; waited += 100) {
      if (cands.some((c) => this.isLive(c))) return true;
      await new Promise<void>((r) => this.timers.setTimeout(r, 100));
    }
    return cands.some((c) => this.isLive(c));
  }

  /** A lobby is live if its admin's latest heartbeat names it, received within the online window (§4.3). */
  private isLive(c: LobbyCandidate): boolean {
    const info = this.presence.info(c.adminPub);
    return info.online && info.value !== null && info.value.lobby === c.lobbyId;
  }

  private disconnectLobby(): void {
    const client = this.lobby;
    this.lobby = null;
    this.lobbyState = null;
    client?.stop();
    this.profileRec = { ...this.profileRec, lobbyCode: null, lobbyId: null };
    this.store.profile.put(this.profileRec).catch(() => undefined);
    this.presence.setState({ lobby: null, game: null, head: null });
    this.presence.watch([]);
    this.maybeRebuild();
    this.emitAll();
  }

  private stopLobby(): void {
    this.lobby?.stop();
    this.joining?.stop();
    this.lobby = null;
    this.joining = null;
    this.lobbyState = null;
  }

  // ------------------------------------------------------------ games

  private currentRuntime(): GameRuntime | null {
    const s = this.lobbyState;
    if (s === null || this.lobby === null) return null;
    const mine = [...this.runtimes.values()].filter((r) => r.lobbyId === s.lobbyId && !r.abandoned);
    const id = selectCurrentGame(s, mine.map((r) => ({ configId: r.configId, keyComplete: keyComplete(r.ev), terminal: isTerminal(r) })));
    if (id === null) return null;
    const rt = this.runtimes.get(id);
    return rt !== undefined && !rt.abandoned ? rt : null;
  }

  private gameActive(): boolean {
    const s = this.lobbyState;
    if (s === null) return false;
    const rt = this.currentRuntime();
    if (rt !== null) return !isTerminal(rt) && !rt.abandoned;
    const cur = s.currentConfig;
    if (cur === null || this.dismissed.has(cur.configId)) return false;
    // a config this device has not evaluated yet
    return !this.runtimes.has(cur.configId);
  }

  private updateGameActive(): void {
    this.lobby?.driver.setGameActive(this.gameActive());
    const rt = this.currentRuntime();
    this.presence.setWakeLock(rt !== null && rt.mode === 'seat' && !isTerminal(rt) && !rt.abandoned);
  }

  /** Creates runtimes for the lobby's current config and running games; supersedes stale accepted configs (§4.6). */
  private syncGames(): void {
    const s = this.lobbyState;
    const client = this.lobby;
    if (s === null || client === null || !this.active || this.identity === null) {
      this.updateGameActive();
      return;
    }
    const msgs = client.messages();
    const byId = new Map(msgs.map((m) => [m.msgId, m]));
    for (const rt of this.runtimes.values()) {
      if (rt.lobbyId !== s.lobbyId) continue;
      const list = conflictingConfigs(rt.configId, msgs);
      const key = list.map((m) => m.msgId).join(',');
      if (key !== rt.conflictKey) {
        rt.conflictKey = key;
        rt.driver.setConflictingConfigs(list);
      }
    }
    const cur = s.currentConfig;
    if (cur !== null && !this.runtimes.has(cur.configId) && !this.accepting.has(cur.configId) && !this.dismissed.has(cur.configId)) {
      const m = byId.get(cur.configId);
      if (m !== undefined) void this.ensureRuntime(m, client.code);
    }
    this.checkSupersede();
    this.updateGameActive();
  }

  /** Supersede (§4.6.3): an accepted config whose key step is incomplete and that is no longer the current game. */
  private checkSupersede(): void {
    const s = this.lobbyState;
    if (s === null || !this.lobbySynced || s.currentConfig === null) return;
    const current = this.currentRuntime()?.configId ?? s.currentConfig.configId;
    for (const rt of [...this.runtimes.values()]) {
      if (rt.lobbyId !== s.lobbyId || rt.mode !== 'seat' || rt.ev === null || isTerminal(rt) || this.dismissed.has(rt.configId)) continue;
      if (isSuperseded(current, rt.configId, keyComplete(rt.ev))) void this.supersede(rt);
    }
  }

  private async supersede(rt: GameRuntime): Promise<void> {
    this.dismissed.add(rt.configId);
    if (rt.record !== null) {
      rt.record = { ...rt.record, status: 'superseded', endedAt: this.clock.now() };
      await this.store.games.put(rt.record);
    }
    this.dropRuntime(rt);
    this.syncGames();
    this.emitAll();
  }

  private dropRuntime(rt: GameRuntime): void {
    rt.driver.stop();
    rt.stopped = true;
    this.runtimes.delete(rt.configId);
  }

  /** Evaluates a config this device has no runtime for: resume, accept (§4.6.2), lost (§3.10) or observe. */
  private async ensureRuntime(configMsg: StoredMsg, lobbyCode: string): Promise<void> {
    const configId = configMsg.msgId;
    const config = configOf(configMsg);
    const id = this.identity;
    if (config === null || id === null || this.accepting.has(configId) || this.runtimes.has(configId)) return;
    const seat = config.seats.findIndex((x) => x.pub === id.pub);
    if (seat < 0) return;
    this.accepting.add(configId);
    try {
      const rec = await this.store.games.get(config.gameId);
      if (rec !== null) {
        if (rec.configId !== configId || rec.status === 'abandoned' || rec.status === 'superseded') {
          // another config of this gameId was accepted (equivocation), or the game was dismissed here
          this.dismissed.add(configId);
          return;
        }
        await this.startRuntime(configMsg, lobbyCode, rec);
        return;
      }
      // No record: observe first, so a device that lost its record never keys twice (§3.10).
      const observer = await this.startRuntime(configMsg, lobbyCode, null);
      if (observer === null) return;
      while (!this.transport.connected() && !observer.stopped && !this.closed) await new Promise<void>((r) => this.timers.setTimeout(r, 200));
      await this.transport.syncedOk(gameSoul(config.gameId, 'setup'));
      await observer.driver.idle();
      if (observer.stopped || this.runtimes.get(configId) !== observer) return;
      const ownKey = observer.driver.messages().some((m) => m.env.type === 'key' && m.env.author === id.pub);
      if (ownKey) {
        observer.mode = 'lost';
        const lost: GameRecord = {
          gameId: config.gameId, lobbyId: configMsg.env.lobby, configId, seat, seed: '', status: 'lost',
          startedAt: this.clock.now(), lobbyCode,
        };
        observer.record = await this.store.games.putIfAbsent(lost);
        this.emitAll();
        return;
      }
      const s = this.lobbyState;
      if (s === null || s.lobbyId !== configMsg.env.lobby) {
        observer.refusal = 'Not in this lobby';
        return;
      }
      const others = (await this.store.games.all()).filter((r) => r.status === 'active' && r.gameId !== config.gameId
        && !(this.runtimes.get(r.configId) !== undefined && isTerminal(this.runtimes.get(r.configId) as GameRuntime)));
      const check = s.currentConfig?.configId === configId
        ? checkConfig(s, id.pub, { activeGameIds: others.map((r) => r.gameId) })
        : { ok: false as const, reason: 'The configuration is no longer current' };
      if (!check.ok) {
        observer.refusal = check.reason;
        this.errors.push(`config ${configId.slice(0, 8)} refused: ${check.reason}`);
        this.emitAll();
        return;
      }
      // Accept: commit gs_j before anything is signed (§2.5, §4.6.2).
      const fresh: GameRecord = {
        gameId: config.gameId, lobbyId: configMsg.env.lobby, configId, seat: check.seat, seed: b64uEncode(randomBytes(32)),
        status: 'active', startedAt: this.clock.now(), lobbyCode,
      };
      const stored = await this.store.games.putIfAbsent(fresh);
      if (stored.configId !== configId) return;
      this.dropRuntime(observer);
      await this.startRuntime(configMsg, lobbyCode, stored);
    } catch (e) {
      this.errors.push('game: ' + errorMessage(e));
    } finally {
      this.accepting.delete(configId);
      this.syncGames();
      this.emitAll();
    }
  }

  /** Starts a runtime: a seat driver with secrets (record), or without (observer / lost). */
  private async startRuntime(configMsg: StoredMsg, lobbyCode: string, rec: GameRecord | null): Promise<GameRuntime | null> {
    const config = configOf(configMsg);
    const id = this.identity;
    if (config === null || id === null) return null;
    const configId = configMsg.msgId;
    const existing = this.runtimes.get(configId);
    if (existing !== undefined) return existing;
    const seat = config.seats.findIndex((x) => x.pub === id.pub);
    if (seat < 0) return null;
    const secrets = rec !== null && rec.status !== 'lost' && rec.seed !== '' ? { gameSeed: b64uDecode(rec.seed, 32) } : null;
    const mode: RuntimeMode = secrets !== null ? 'seat' : rec?.status === 'lost' ? 'lost' : 'observer';
    const lobbyId = configMsg.env.lobby;
    // cached transcript and verdicts (§3.10 steps 2-3)
    const cached = await this.store.transcript.forScope(config.gameId);
    const known = await this.store.verdicts.getMany(cached.map((c) => decodeCached(c.value, c.key)).flatMap((d) => ('error' in d ? [] : [d.msgId])));
    for (const [k, v] of known) this.verdicts.preload(k, v);
    if (this.runtimes.has(configId)) return this.runtimes.get(configId) ?? null;
    const counting = new CountingCrypto(this.cryptoBackend);
    const recording = this.recordingTransport(lobbyCode);
    const msgs = this.lobby?.messages() ?? [];
    const ref: { rt: GameRuntime | null } = { rt: null };
    const driver = new SeatDriver({
      config, configId, lobbyId, lobbyCode, seat, signer: id.signer, secrets, transport: recording, journal: this.store.journal,
      crypto: counting, verdictCache: this.verdicts, now: () => this.clock.now(), configAuthor: configMsg.env.author,
      createdAt: configMsg.env.t, conflictingConfigs: conflictingConfigs(configId, msgs),
      onView: (v) => {
        if (ref.rt !== null) this.onView(ref.rt, v);
      },
      onEval: (ev) => {
        if (ref.rt !== null) this.onEval(ref.rt, ev);
      },
      onError: (e) => this.errors.push(`seat ${seat}: ${errorMessage(e)}`),
    });
    const rt: GameRuntime = {
      configId, config, configMsg, lobbyId, lobbyCode, seat, mode, refusal: null, record: rec, driver, crypto: counting,
      view: null, ev: null, pendingKey: null, pendingSince: null, terminalAt: null, terminalWall: null,
      recovering: cached.length > 0, abandoned: false, lastHistoryJson: '', stopped: false, conflictKey: '',
    };
    ref.rt = rt;
    this.runtimes.set(configId, rt);
    this.record(configMsg, lobbySoul(lobbyCode), lobbyId);
    const setupSoul = gameSoul(config.gameId, 'setup');
    const playSoul = gameSoul(config.gameId, 'play');
    for (const c of cached) {
      if (c.soul === setupSoul || c.soul === playSoul) rt.driver.ingest(c.soul, c.key, c.value);
    }
    void rt.driver.start().catch((e: unknown) => this.errors.push('start: ' + errorMessage(e)));
    return rt;
  }

  /** A transport for a game driver that persists every verified game message (§3.4 step 4). */
  private recordingTransport(lobbyCode: string): Transport {
    const t = this.transport;
    return {
      publish: (soul, key, value) => t.publish(soul, key, value),
      subscribe: (soul, onValue) => t.subscribe(soul, (key, value) => {
        onValue(key, value);
        const d = decodeCached(value, key);
        if ('error' in d || d.env.game === '') return;
        try {
          if (soulOf(d.env, lobbyCode) !== soul) return;
        } catch {
          return;
        }
        this.record(d, soul, d.env.game);
      }),
      synced: (soul) => t.synced(soul),
    };
  }

  private record(m: StoredMsg, soul: string, scope: string): void {
    if (this.recorded.has(m.msgId)) return;
    this.recorded.add(m.msgId);
    this.store.transcript.add(m.msgId, { soul, key: m.key, value: m.value, scope }).catch(() => {
      this.recorded.delete(m.msgId);
    });
  }

  private onEval(rt: GameRuntime, ev: GameEval): void {
    rt.ev = ev;
    const now = this.timers.now();
    const p = ev.terminal === null ? ev.pending : null;
    const key = p === null ? null : p.step.id;
    if (key !== rt.pendingKey) {
      rt.pendingKey = key;
      rt.pendingSince = key === null ? null : now;
    }
    if (rt.recovering && ev.jobs.length === 0) rt.recovering = false;
    if (rt.record !== null && rt.mode === 'seat' && keyComplete(ev) && rt.record.keyCompletedAt === undefined) {
      rt.record = { ...rt.record, keyCompletedAt: this.clock.now() };
      this.store.games.put(rt.record).catch(() => undefined);
    }
    if (ev.terminal !== null && rt.terminalAt === null) {
      rt.terminalAt = now;
      rt.terminalWall = this.clock.now();
      if (rt.record !== null && rt.record.status === 'active') {
        rt.record = { ...rt.record, status: 'ended', endedAt: rt.terminalWall };
        this.store.games.put(rt.record).catch(() => undefined);
      }
    }
    if (this.currentRuntime() === rt) this.presence.setState({ lobby: rt.lobbyId, game: rt.config.gameId, head: ev.head });
    this.checkSupersede();
    this.updateGameActive();
    this.refreshStatus();
  }

  private onView(rt: GameRuntime, v: SeatView): void {
    rt.view = v;
    const out = v.outcome;
    if (rt.mode === 'seat' && v.terminal && out !== null && (out.state === 'GOOD_WIN' || out.state === 'EVIL_WIN')) {
      const entry: HistoryEntry = {
        gameId: rt.config.gameId, outcome: out, myName: rt.config.seats[rt.seat].name,
        startedAt: rt.record?.keyCompletedAt ?? rt.record?.startedAt ?? 0,
        endedAt: rt.terminalWall ?? this.clock.now(),
      };
      const json = JSON.stringify(entry);
      if (json !== rt.lastHistoryJson) {
        rt.lastHistoryJson = json;
        this.store.history.put(entry).catch(() => undefined);
      }
    }
    this.emitAll();
  }

  // ------------------------------------------------------------ connectivity (§7.3, §7.4)

  private onHi(): void {
    if (!this.active) return;
    this.transport.resetEchoes();
    void this.lobby?.republishJournal().catch(() => undefined);
    for (const rt of this.runtimes.values()) void rt.driver.republish(false).catch(() => undefined);
    this.transport.reask(this.transport.activeSouls());
  }

  private onNewBoot(): void {
    if (!this.active) return;
    this.transport.resetEchoes();
    this.lobby?.republishAll();
    void this.lobby?.republishJournal().catch(() => undefined);
    for (const rt of this.runtimes.values()) void rt.driver.republish(true).catch(() => undefined);
  }

  private tick(): void {
    if (this.closed) return;
    const now = this.timers.now();
    if (this.active) {
      const rt = this.currentRuntime();
      // §7.3 backstop: re-ask the souls while a step has been pending > 10 s
      if (rt !== null && rt.pendingSince !== null && now - rt.pendingSince > REASK_AFTER_MS && now - this.lastReask >= REASK_EVERY_MS) {
        this.lastReask = now;
        const souls = [gameSoul(rt.config.gameId, 'setup'), gameSoul(rt.config.gameId, 'play')];
        if (this.lobby !== null) souls.unshift(this.lobby.soul);
        this.transport.reask(souls);
      }
      // §7.4: re-put own messages not echoed yet
      if (now - this.lastReput >= REPUT_EVERY_MS) {
        this.lastReput = now;
        for (const r of this.runtimes.values()) if (!isTerminal(r)) void r.driver.republish(false).catch(() => undefined);
      }
      if (Math.floor(now / DRIVER_TICK_MS) !== Math.floor((now - TICK_MS) / DRIVER_TICK_MS)) {
        for (const r of this.runtimes.values()) r.driver.tick();
      }
      // drop finished background games after 10 minutes (§7.3)
      const cur = this.currentRuntime();
      let dropped = false;
      for (const r of [...this.runtimes.values()]) {
        if (r === cur) continue;
        if ((r.terminalAt !== null && now - r.terminalAt > KEEP_ENDED_MS) || r.abandoned) {
          this.dropRuntime(r);
          dropped = true;
        }
      }
      if (dropped) this.maybeRebuild();
    }
    this.refreshStatus();
  }

  /** A fresh GUN instance when the subscribed set shrank (§7.3). */
  private maybeRebuild(): void {
    const keep = new Set<string>();
    if (this.lobby !== null) keep.add(this.lobby.soul);
    if (this.joining !== null) keep.add(this.joining.soul);
    for (const rt of this.runtimes.values()) {
      keep.add(gameSoul(rt.config.gameId, 'setup'));
      keep.add(gameSoul(rt.config.gameId, 'play'));
    }
    const subscribed = this.transport.subscriptions.allSouls();
    if (subscribed.some((s) => !keep.has(s))) this.transport.rebuild();
  }

  // ------------------------------------------------------------ projections

  private lobbyData(): LobbyData | null {
    const s = this.lobbyState;
    if (s === null || this.lobby === null || this.identity === null) return null;
    const admin = s.head.members.find((m) => m.pub === s.head.admin);
    const users: Record<string, LobbyUser> = {};
    for (const m of s.head.members) users[m.name] = { name: m.name, uid: m.pub };
    const rt = this.currentRuntime();
    const game = rt?.view?.game ?? emptyGameData();
    return { name: this.lobby.code, admin: { uid: s.head.admin, name: admin?.name ?? '' }, users, game };
  }

  private roleDoc(): RoleDoc | null {
    const rt = this.currentRuntime();
    if (rt === null || rt.mode !== 'seat') return null;
    return rt.view?.role ?? null;
  }

  private computeStatus(): SessionStatus {
    if (this.lock !== undefined && !this.lock.held) return { kind: 'READ_ONLY_OTHER_TAB' };
    if (this.storeError) return { kind: 'LOST_SECRETS' };
    if (!this.everConnected && !this.transport.connected()) return { kind: 'CONNECTING' };
    if (this.lobby === null) return { kind: 'LOBBY' };
    if (this.lobbyState === null) return { kind: 'CONNECTING' };
    const rt = this.currentRuntime();
    if (rt === null) return { kind: 'LOBBY' };
    const ev = rt.ev;
    const n = rt.config.seats.length;
    if (ev === null) return rt.recovering ? { kind: 'SYNCING', percent: 0 } : { kind: 'STARTING', progress: { stage: 'keys', done: 0, total: n, waitingFor: [] } };
    if (ev.terminal !== null) {
      const revealed = new Set(rt.driver.messages().filter((m) => m.env.type === 'reveal').map((m) => m.env.author));
      const count = rt.config.seats.filter((x) => revealed.has(x.pub)).length;
      const since = rt.terminalAt === null ? 0 : this.timers.now() - rt.terminalAt;
      if (count < n && since < ENDING_MAX_MS) return { kind: 'ENDING', revealed: count, total: n };
      return { kind: 'ENDED' };
    }
    if (rt.mode === 'lost') return { kind: 'LOST_SECRETS' };
    if (rt.recovering && ev.jobs.length > 0) {
      const c = rt.crypto;
      const percent = c.submitted === 0 ? 0 : Math.min(99, Math.floor((100 * c.completed) / (c.submitted + ev.jobs.length)));
      return { kind: 'SYNCING', percent };
    }
    const p = ev.pending;
    const since = rt.pendingSince === null ? 0 : this.timers.now() - rt.pendingSince;
    if (p !== null && p.stuck === undefined) {
      const missing = p.missing.filter((j) => j !== rt.seat);
      if (p.step.kind === 'setup' || p.step.kind === 'automatic') {
        if (missing.length > 0 && since >= AUTOMATIC_STALL_MS) {
          return { kind: 'STALLED', seats: missing.map((j) => rt.config.seats[j].name), sinceMs: since };
        }
      } else if (since >= HUMAN_STALL_MS) {
        // human steps: stalled when a missing actor's device is offline (§7.8); at `as` the assassin is secret
        const candidates = p.step.kind === 'assassination' ? rt.config.seats.map((_, j) => j).filter((j) => j !== rt.seat) : missing;
        const offline = candidates.filter((j) => !this.presence.isOnline(rt.config.seats[j].pub));
        if (offline.length > 0) {
          return { kind: 'STALLED', seats: offline.map((j) => rt.config.seats[j].name), sinceMs: since };
        }
      }
    } else if (p !== null && p.stuck !== undefined && since >= AUTOMATIC_STALL_MS) {
      return { kind: 'STALLED', seats: p.missing.filter((j) => j !== rt.seat).map((j) => rt.config.seats[j].name), sinceMs: since };
    }
    if (ev.state.phase === 'SETUP' || rt.view?.game.state === 'INIT') {
      const progress = rt.view?.progress ?? rt.view?.game.setup ?? { stage: 'sight', done: n, total: n, waitingFor: [] };
      return { kind: progress.stage === 'keys' ? 'STARTING' : 'SETUP', progress };
    }
    return { kind: 'ACTIVE' };
  }

  private refreshStatus(): void {
    const s = this.computeStatus();
    // sinceMs and percent change every tick; the UI keeps its own timers, so only a change of kind/seats/progress is emitted
    const key = JSON.stringify(s.kind === 'STALLED' ? { k: s.kind, seats: s.seats } : s);
    if (key !== this.lastStatusKey) {
      this.lastStatusKey = key;
      this.statusEmitter.emit();
    }
  }

  private emitProfile(): void {
    const json = JSON.stringify(this.profile);
    if (json !== this.lastProfileJson) {
      this.lastProfileJson = json;
      this.profileEmitter.emit();
    }
  }

  private emitAll(): void {
    this.emitProfile();
    const role = JSON.stringify(this.roleDoc());
    if (role !== this.lastRoleJson) {
      this.lastRoleJson = role;
      this.roleEmitter.emit();
    }
    const lobby = JSON.stringify(this.lobbyData());
    if (lobby !== this.lastLobbyJson) {
      this.lastLobbyJson = lobby;
      this.lobbyEmitter.emit();
    }
    this.refreshStatus();
  }

  // ------------------------------------------------------------ guards

  private requireWriter(): void {
    if (this.closed) throw new Error('Session closed');
    if (!this.lock.held) throw new Error('Avalon is open in another tab');
  }

  private requireIdentity(): Identity {
    this.requireWriter();
    if (this.identity === null) throw new Error('Not logged in');
    return this.identity;
  }

  private requireLobby(): LobbyClient {
    if (this.lobby === null) throw new Error('Not in a lobby');
    return this.lobby;
  }

  private requireLobbyState(): LobbyState {
    const s = this.lobbyState;
    if (s === null) throw new Error('Lobby not loaded yet');
    return s;
  }

  private requirePlaying(): GameRuntime {
    this.requireWriter();
    const rt = this.currentRuntime();
    if (rt === null || rt.abandoned) throw new Error('No game in progress');
    if (rt.mode === 'lost') throw new Error('This browser lost the secret keys for this game');
    if (rt.mode !== 'seat') throw new Error(rt.refusal ?? 'You are not playing in this game');
    return rt;
  }
}

