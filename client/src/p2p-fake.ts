/*
 * TEMPORARY FAKE SESSION (WP-F stage 1). Deleted at integration (docs/p2p-protocol.md §13, step 3).
 *
 * This file has two jobs while WP-B (common/protocol) and WP-D (client/src/p2p/session.ts) are not merged:
 *
 * 1. Mirror types. It declares local copies of the view types of `common/protocol/views.ts`, the
 *    `SetupProgress`/`UserStats` types of `common/protocol/types.ts`, `LobbyCandidate` of
 *    `common/protocol/lobby.ts` and `SessionStatus`/`LocalProfile` of `client/src/p2p/session.ts`,
 *    exactly as §11.2 specifies them. `client/src/types.ts` and `client/src/avalon.ts` import them from
 *    here; at integration those two imports switch to '@avalon/common/protocol' and './p2p/session'.
 *
 * 2. A fake `P2PSession` with the exact public surface of §11.2. It runs a scripted game on this device
 *    against bots so the UI can be developed and exercised without the protocol stack. Nothing is sent
 *    over the network. Scenarios are selected with URL parameters:
 *
 *      ?fakeBots=N        number of bots that join a lobby you create (default 4, i.e. 5 players)
 *      ?fakeSpeed=X       speed multiplier for every simulated delay (default 1)
 *      ?fakeStall=PREFIX  one bot (two for `reveal`) stops acting at the first step whose id starts with
 *                         PREFIX: key, shuf, deal, otR, otS, p, vc, vr, mv, mt, as, reveal. The status turns
 *                         STALLED; a stalled bot never reveals at the end (results incomplete / UNKNOWN roles).
 *      ?fakeCheat=1       a bot publishes an invalid ballot proof at the first tally: INVALID, its team forfeits.
 *      ?fake=lost         this device "lost its game keys" when a game starts (LOST_SECRETS).
 *      ?fake=readonly     the session starts as READ_ONLY_OTHER_TAB until useHere().
 *      ?fake=offline      the relay connection drops 5 s after start for 40 s (connection banners).
 *      ?fake=autostart    when you create a lobby and the bots have joined, the game starts by itself.
 *
 *    Lobby codes for joining: codes starting with X are not found, ZZZZ has two candidates (chooser),
 *    any other valid 4-letter code finds one lobby administered by a bot that starts the game by itself.
 */

import { ROLES, getNumEvilForGameSize, type Role } from '@avalon/common/avalonlib';

// ----------------------------------------------------------------------------------------------
// Mirror types (§3.2, §11.2). Keep in sync with the spec; deleted with this file.
// ----------------------------------------------------------------------------------------------

export type Hex32 = string;
export type Pub = string;

// common/protocol/views.ts
export interface Proposal { proposer: string; team: string[]; votes: string[]; state: 'PENDING' | 'APPROVED' | 'REJECTED' }
export interface Mission {
  state: 'PENDING' | 'SUCCESS' | 'FAIL'; team: string[]; teamSize: number; failsRequired: number;
  numFails: number; proposals: Proposal[]; evilOnTeam?: string[];
}
export interface RoleAssignment { name: string; role: string /* may be 'UNKNOWN' */; assassin?: boolean }
export interface GameOutcome {
  state: 'GOOD_WIN' | 'EVIL_WIN' | 'CANCELED';
  message: string;
  assassinated?: string;
  roles: RoleAssignment[];                 // role may be 'UNKNOWN'
  votes: Record<string, boolean>[];        // votes[m][name] = true for SUCCESS; key absent if unknown
  final: boolean;                          // every role and every vote known
  unrevealed: string[];
  cheaters: { name: string; reason: string }[];
  canceledBy?: string;
  stalled?: string[];
}
export interface GameData {
  state: 'INIT' | 'ACTIVE' | 'ENDED'; phase: string; players: string[]; roles: string[];
  missions: Mission[]; outcome?: GameOutcome; options?: Record<string, unknown>;
  setup?: SetupProgress;
}
export interface LobbyUser { name: string; uid?: string }
export interface LobbyData { name: string; admin: { uid: string; name: string }; users: Record<string, LobbyUser>; game: GameData }
export interface RoleDoc { role: Role; assassin: boolean; sees?: string[] }

// common/protocol/types.ts
export interface SetupProgress { stage: 'keys' | 'shuffle' | 'deal' | 'sight'; done: number; total: number; waitingFor: string[] }
export interface UserStats { games: number; good: number; evil: number; wins: number; good_wins: number; evil_wins: number; playtimeSeconds: number }

// common/protocol/lobby.ts
export interface LobbyCandidate { lobbyId: Hex32; code: string; adminPub: Pub; adminName: string; members: string[]; fingerprint: string }

// client/src/p2p/session.ts
export type SessionStatus =
  | { kind: 'CONNECTING' | 'LOBBY' | 'ACTIVE' | 'ENDED' | 'LOST_SECRETS' | 'READ_ONLY_OTHER_TAB' }
  | { kind: 'SYNCING'; percent: number } | { kind: 'STARTING' | 'SETUP'; progress: SetupProgress }
  | { kind: 'STALLED'; seats: string[]; sinceMs: number } | { kind: 'ENDING'; revealed: number; total: number };
export interface LocalProfile { uid: Pub; name: string | null; lobby: string | null }

// ----------------------------------------------------------------------------------------------
// Fake implementation
// ----------------------------------------------------------------------------------------------

const LOBBY_ALPHABET = 'ABCDEFGHJKLMNPQRSTVWXYZ';
const BOT_NAMES = ['ARTHUR', 'GAWAIN', 'LANCELOT', 'TRISTAN', 'GALAHAD', 'BEDIVERE', 'KAY', 'GARETH', 'LAMORAK', 'PELLINORE'];
const MISSION_SIZES: Record<number, number[]> = {
  5: [2, 3, 2, 3, 3], 6: [2, 3, 4, 3, 4], 7: [2, 3, 3, 4, 4], 8: [3, 4, 4, 5, 5], 9: [3, 4, 4, 5, 5], 10: [3, 4, 4, 5, 5],
};
const STORAGE_IDENTITY = 'avalon-fake-identity';
const STORAGE_HISTORY = 'avalon-fake-history';
const REVEAL_GIVE_UP_MS = 60000;

interface FakeOptions {
  bots: number;
  speed: number;
  stallAt: string | null;
  cheat: boolean;
  lost: boolean;
  readonly: boolean;
  offline: boolean;
  autostart: boolean;
}

function readOptions(): FakeOptions {
  let params = new URLSearchParams();
  try {
    params = new URLSearchParams(globalThis.location?.search ?? '');
  } catch {
    // not in a browser
  }
  const flags = (params.get('fake') ?? '').split(',');
  const bots = Number(params.get('fakeBots') ?? '4');
  const speed = Number(params.get('fakeSpeed') ?? '1');
  return {
    bots: Number.isInteger(bots) && bots >= 0 && bots <= 9 ? bots : 4,
    speed: speed > 0 ? speed : 1,
    stallAt: params.get('fakeStall'),
    cheat: params.get('fakeCheat') === '1',
    lost: flags.includes('lost'),
    readonly: flags.includes('readonly'),
    offline: flags.includes('offline'),
    autostart: flags.includes('autostart'),
  };
}

function storageGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string | null): void {
  try {
    if (value == null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    // storage unavailable: the fake simply forgets
  }
}

function randomInt(n: number): number {
  return Math.floor(Math.random() * n);
}

function randomString(alphabet: string, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[randomInt(alphabet.length)];
  return s;
}

const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const HEX = '0123456789abcdef';

function randomPub(): Pub {
  return randomString(B64U, 43) + '.' + randomString(B64U, 43);
}

function shuffle<T>(list: readonly T[]): T[] {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function clone<T>(v: T): T {
  return v == null ? v : JSON.parse(JSON.stringify(v)) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function validateName(name: string): string | null {
  if (!name) return 'Invalid name';
  if (!/^[A-Z]+$/.test(name) || name.length > 20) return 'Invalid name';
  if (ROLES.some(r => r.name === name)) return 'Invalid name';
  return null;
}

function roleByName(name: string): Role {
  const role = ROLES.find(r => r.name === name);
  if (!role) throw new Error('Unknown role ' + name);
  return role;
}

function joinWithAnd(list: readonly string[]): string {
  if (list.length <= 1) return list.join('');
  return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
}

class Emitter<T> {
  private listeners = new Set<(v: T) => void>();
  constructor(private readonly current: () => T) {}
  on(cb: (v: T) => void): () => void {
    this.listeners.add(cb);
    cb(clone(this.current()));
    return () => { this.listeners.delete(cb); };
  }
  emit(): void {
    const v = this.current();
    for (const cb of [...this.listeners]) cb(clone(v));
  }
}

interface Member { pub: Pub; name: string; bot: boolean }

interface Seat extends Member { role: string; assassin: boolean }

interface StepState {
  id: string;                 // step id as in §3.5 (key, shuf/j, deal, otR, otS, p/m/p, vc/m/p, vr/m/p, mv/m, mt/m, as)
  req: string[];              // names that must act
  done: Set<string>;
  since: number;              // Date.now() when the step became pending
}

interface FakeGame {
  seats: Seat[];
  selectedRoles: string[];
  options: { inGameLog: boolean };
  state: 'INIT' | 'ACTIVE' | 'ENDED';
  phase: string;
  setup: SetupProgress | null;
  missions: Mission[];
  proposer: number;
  commits: Map<string, boolean>;        // name -> approve (vote.commit at the current proposal)
  ballots: Map<string, boolean>;        // name -> fail (ballot at the current mission)
  missionVotes: Record<string, boolean>[];   // per mission: name -> success
  step: StepState | null;
  stalled: Set<string>;
  stallUsed: boolean;
  cheatUsed: boolean;
  outcome: GameOutcome | null;
  terminal: { state: GameOutcome['state']; message: string; assassinated?: string; canceledBy?: string;
              stalled?: string[]; cheaters: { name: string; reason: string }[] } | null;
  revealed: Set<string>;
  terminalAt: number;
  startedAt: number;
  ended: boolean;                 // reveals done or given up: status ENDED, history written
  lost: boolean;
  abandoned: boolean;
}

interface FakeLobby {
  code: string;
  lobbyId: Hex32;
  admin: Pub;
  members: Member[];
  game: FakeGame | null;
}

interface FakeHistoryEntry { state: GameOutcome['state']; team: 'good' | 'evil' | null; seconds: number }

/**
 * Fake P2PSession: same public API as client/src/p2p/session.ts (§11.2), simulated locally.
 */
export class P2PSession {
  private _profile: LocalProfile | null = null;
  private _status: SessionStatus = { kind: 'CONNECTING' };
  private _connected = true;
  private _readOnly: boolean;
  private _lobby: FakeLobby | null = null;
  private readonly _opts: FakeOptions;
  private readonly _timers = new Set<ReturnType<typeof setTimeout>>();
  private _lastStatusJson = '';
  private readonly _profileEmitter = new Emitter<LocalProfile | null>(() => this._profile);
  private readonly _lobbyEmitter = new Emitter<LobbyData | null>(() => this._projectLobby());
  private readonly _roleEmitter = new Emitter<RoleDoc | null>(() => this._projectRole());
  private readonly _statusEmitter = new Emitter<SessionStatus>(() => this._status);

  private constructor() {
    this._opts = readOptions();
    this._readOnly = this._opts.readonly;
    const stored = storageGet(STORAGE_IDENTITY);
    if (stored) {
      try {
        const id = JSON.parse(stored) as { uid?: unknown };
        if (typeof id.uid === 'string') this._profile = { uid: id.uid, name: null, lobby: null };
      } catch {
        // corrupt: start without identity
      }
    }
    if (this._opts.offline) {
      this._after(5000, () => { this._connected = false; });
      this._after(45000, () => { this._connected = true; });
    }
    setInterval(() => this._tick(), 1000);
  }

  static async open(_o?: { relayUrl?: string }): Promise<P2PSession> {
    console.warn('Avalon: using the FAKE P2P session (client/src/p2p-fake.ts); nothing leaves this browser.');
    const session = new P2PSession();
    await sleep(300);
    session._refreshStatus();
    return session;
  }

  get profile(): LocalProfile | null { return clone(this._profile); }
  get status(): SessionStatus { return clone(this._status); }
  get connected(): boolean { return this._connected; }

  onProfile(cb: (p: LocalProfile | null) => void): () => void { return this._profileEmitter.on(cb); }
  onLobby(cb: (l: LobbyData | null) => void): () => void { return this._lobbyEmitter.on(cb); }
  onRole(cb: (r: RoleDoc | null) => void): () => void { return this._roleEmitter.on(cb); }
  onStatus(cb: (s: SessionStatus) => void): () => void { return this._statusEmitter.on(cb); }

  async createIdentity(): Promise<void> {
    await sleep(200);
    if (this._profile) return;
    this._profile = { uid: randomPub(), name: null, lobby: null };
    storageSet(STORAGE_IDENTITY, JSON.stringify({ uid: this._profile.uid }));
    this._profileEmitter.emit();
  }

  async resetIdentity(): Promise<void> {
    if (this._gameNonTerminal()) throw new Error('Cannot log out during a game');
    this._clearTimers();
    this._lobby = null;
    this._profile = null;
    storageSet(STORAGE_IDENTITY, null);
    storageSet(STORAGE_HISTORY, null);
    this._emitAll();
  }

  async createLobby(name: string): Promise<{ lobby: string }> {
    const me = this._requireProfile();
    const bad = validateName(name);
    if (bad) throw new Error(bad);
    if (this._lobby) throw new Error('Already in a lobby');
    await sleep(this._ms(800));
    const code = randomString(LOBBY_ALPHABET, 4);
    this._lobby = {
      code, lobbyId: randomString(HEX, 64), admin: me.uid,
      members: [{ pub: me.uid, name, bot: false }], game: null,
    };
    this._profile = { ...me, name, lobby: code };
    const botNames = BOT_NAMES.filter(b => b !== name).slice(0, this._opts.bots);
    botNames.forEach((botName, i) => this._after(this._ms(700 * (i + 1)), () => {
      const lobby = this._lobby;
      if (!lobby || lobby.code !== code || lobby.members.length >= 10 || this._gameNonTerminal()) return;
      lobby.members.push({ pub: randomPub(), name: botName, bot: true });
      this._emitAll();
      if (this._opts.autostart && i === botNames.length - 1) {
        this._after(this._ms(1000), () => {
          void this.startGame(lobby.members.map(m => m.name), this._defaultRoles(), { inGameLog: false }).catch(() => undefined);
        });
      }
    }));
    this._emitAll();
    return { lobby: code };
  }

  async findLobbies(code: string): Promise<LobbyCandidate[]> {
    await sleep(this._ms(600));
    if (!new RegExp(`^[${LOBBY_ALPHABET}]{4}$`).test(code) || code.startsWith('X')) return [];
    const make = (seed: number): LobbyCandidate => {
      const lobbyId = (code.charCodeAt(0).toString(16) + seed + 'a7f3' + '0'.repeat(64)).slice(0, 64);
      const members = BOT_NAMES.slice(seed, seed + Math.min(this._opts.bots, 4));
      return { lobbyId, code, adminPub: 'bot-admin-' + seed, adminName: members[0], members,
               fingerprint: lobbyId.slice(0, 4).toUpperCase() };
    };
    const own = this._lobby;
    if (own && own.code === code) {
      const admin = own.members.find(m => m.pub === own.admin);
      return [{ lobbyId: own.lobbyId, code, adminPub: own.admin, adminName: admin?.name ?? '',
                members: own.members.map(m => m.name), fingerprint: own.lobbyId.slice(0, 4).toUpperCase() }];
    }
    return code === 'ZZZZ' ? [make(0), make(1)] : [make(0)];
  }

  async joinLobby(name: string, code: string, lobbyId?: Hex32): Promise<{ lobby: string }> {
    const me = this._requireProfile();
    const bad = validateName(name);
    if (bad) throw new Error(bad);
    if (this._lobby) throw new Error('Already in a lobby');
    const all = await this.findLobbies(code);
    const candidates = lobbyId ? all.filter(c => c.lobbyId === lobbyId) : all;
    if (candidates.length === 0) throw new Error(`Lobby ${code} not found`);
    if (candidates.length > 1) throw new Error('Several lobbies use code ' + code + '; choose one');
    const cand = candidates[0];
    await sleep(this._ms(1200));           // "Waiting for ADMIN to admit you"
    if (cand.members.includes(name)) throw new Error('Name taken');
    if (cand.members.length >= 10) throw new Error('Lobby full');
    const members: Member[] = cand.members.map((n, i) => ({ pub: i === 0 ? cand.adminPub : randomPub(), name: n, bot: true }));
    members.push({ pub: me.uid, name, bot: false });
    this._lobby = { code, lobbyId: cand.lobbyId, admin: cand.adminPub, members, game: null };
    this._profile = { ...me, name, lobby: code };
    this._emitAll();
    // The bot admin starts a game once there are enough players.
    this._after(this._ms(4000), () => {
      const lobby = this._lobby;
      if (!lobby || lobby.lobbyId !== cand.lobbyId || lobby.game || lobby.members.length < 5) return;
      this._startGameInternal(lobby, lobby.members.map(m => m.name), this._defaultRoles(), { inGameLog: true });
    });
    return { lobby: code };
  }

  async leaveLobby(): Promise<void> {
    const me = this._requireProfile();
    const lobby = this._lobby;
    if (!lobby) throw new Error('Not in a lobby');
    await sleep(this._ms(300));
    const game = lobby.game;
    if (game && game.state !== 'ENDED' && !game.abandoned && game.phase !== 'ASSASSINATION' && !this._rule2a(game)) {
      this._terminate(game, { state: 'CANCELED', message: `${this._myName()} left the game`, canceledBy: this._myName() });
    }
    this._clearTimers();
    this._lobby = null;
    this._profile = { ...me, lobby: null };
    this._emitAll();
  }

  async kickPlayer(name: string): Promise<void> {
    const lobby = this._requireLobby();
    if (lobby.admin !== this._requireProfile().uid) throw new Error('Only the admin can kick players');
    if (this._gameNonTerminal()) throw new Error('Cancel game first');
    if (name === this._myName()) throw new Error('Cannot kick yourself');
    if (!lobby.members.some(m => m.name === name)) throw new Error('No such player ' + name);
    await sleep(this._ms(400));
    lobby.members = lobby.members.filter(m => m.name !== name);
    this._emitAll();
  }

  async takeOverAdmin(): Promise<void> {
    const lobby = this._requireLobby();
    const me = this._requireProfile();
    if (lobby.admin === me.uid) throw new Error('You are already the admin');
    await sleep(this._ms(400));
    lobby.admin = me.uid;
    this._emitAll();
  }

  async startGame(playerList: string[], roles: string[], options: { inGameLog: boolean }): Promise<void> {
    const lobby = this._requireLobby();
    if (lobby.admin !== this._requireProfile().uid) throw new Error('Only the admin can start the game');
    if (this._gameNonTerminal()) throw new Error('Game already in progress');
    if (playerList.length < 5) throw new Error('Need at least 5 players');
    if (playerList.length > 10) throw new Error('Cannot start game with more than 10 players');
    const names = lobby.members.map(m => m.name);
    if (playerList.length !== names.length || !playerList.every(n => names.includes(n))) {
      throw new Error('Bad player list: ' + [...playerList].sort() + '. In lobby: ' + [...names].sort());
    }
    if (!roles.every(r => ROLES.some(x => x.name === r && x.selectable))) throw new Error('Bad roles ' + roles);
    await sleep(this._ms(300));
    this._startGameInternal(lobby, playerList, roles, options);
  }

  async cancelGame(): Promise<void> {
    const game = this._requireLobby().game;
    if (!game || game.state === 'ENDED' || game.abandoned) throw new Error('No game in progress');
    if (game.phase === 'ASSASSINATION') throw new Error('Cannot cancel during the assassination');
    if (this._rule2a(game)) throw new Error('Canceling now would forfeit');
    await sleep(this._ms(300));
    const me = this._myName();
    const waiting = game.step ? game.step.req.filter(n => !game.step!.done.has(n) && n !== me) : [];
    let message = `Canceled by ${me}`;
    if (game.lost) message = `${me} lost their game keys`;
    else if (game.step?.id === 'key' && this._lobby?.admin === this._profile?.uid) message = `${me} aborted the start`;
    if (waiting.length && !game.lost) message += ', waiting for ' + waiting.join(', ');
    this._terminate(game, { state: 'CANCELED', message, canceledBy: me, stalled: waiting });
  }

  async abandonGame(): Promise<void> {
    const game = this._requireLobby().game;
    if (!game || game.state === 'ENDED') throw new Error('No game in progress');
    await sleep(this._ms(200));
    // Local only: stop waiting, publish nothing. The fake forgets the game (the real session marks it 'abandoned').
    game.abandoned = true;
    this._emitAll();
  }

  async proposeTeam(names: string[]): Promise<void> {
    const game = this._requireActive('TEAM_PROPOSAL', 'Not in team proposal phase');
    const me = this._myName();
    if (game.seats[game.proposer].name !== me) throw new Error('You are not the proposer');
    const mission = this._currentMission(game);
    if (names.length !== mission.teamSize) throw new Error('Bad team size. Need ' + mission.teamSize);
    if (new Set(names).size !== names.length) throw new Error('Duplicate team members');
    if (!names.every(n => game.seats.some(s => s.name === n))) throw new Error('Unknown player in team');
    await sleep(this._ms(300));
    this._propose(game, names);
  }

  async voteTeam(approve: boolean): Promise<void> {
    const game = this._requireActive('PROPOSAL_VOTE', 'Not in proposal vote phase');
    const me = this._myName();
    if (game.commits.has(me)) throw new Error('Already voted');
    await sleep(this._ms(400));        // the commitment is hashed and signed
    this._commitVote(game, me, approve);
  }

  async doMission(success: boolean): Promise<void> {
    const game = this._requireActive('MISSION_VOTE', 'Not in mission phase');
    const me = this._myName();
    const team = this._currentProposal(game).team;
    if (!team.includes(me)) throw new Error('You are not on the mission team');
    if (game.ballots.has(me)) throw new Error('Already voted');
    await sleep(this._ms(500));        // the ballot proof takes a moment
    this._castBallot(game, me, success);
  }

  async assassinate(name: string): Promise<void> {
    const game = this._requireActive('ASSASSINATION', 'Not in assassination phase');
    const me = game.seats.find(s => s.name === this._myName());
    if (!me?.assassin) throw new Error('You are not the assassin');
    if (name === me.name || !game.seats.some(s => s.name === name)) throw new Error('Bad assassination target');
    await sleep(this._ms(400));
    this._assassinate(game, name);
  }

  async useHere(): Promise<void> {
    await sleep(200);
    this._readOnly = false;
    this._refreshStatus();
  }

  async userStats(): Promise<UserStats> {
    const stats: UserStats = { games: 0, good: 0, evil: 0, wins: 0, good_wins: 0, evil_wins: 0, playtimeSeconds: 0 };
    for (const h of this._history()) {
      if (h.state === 'CANCELED' || !h.team) continue;
      const won = (h.state === 'GOOD_WIN') === (h.team === 'good');
      stats.games++;
      stats[h.team]++;
      stats.playtimeSeconds += h.seconds;
      if (won) {
        stats.wins++;
        if (h.team === 'good') stats.good_wins++; else stats.evil_wins++;
      }
    }
    return stats;
  }

  // ------------------------------------------------------------------ internals

  private _ms(ms: number): number {
    return Math.round(ms / this._opts.speed);
  }

  private _after(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this._timers.delete(t);
      fn();
    }, ms);
    this._timers.add(t);
  }

  private _clearTimers(): void {
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
  }

  private _requireProfile(): LocalProfile {
    if (!this._profile) throw new Error('Not logged in');
    return this._profile;
  }

  private _requireLobby(): FakeLobby {
    if (!this._lobby) throw new Error('Not in a lobby');
    return this._lobby;
  }

  private _myName(): string {
    return this._profile?.name ?? '';
  }

  private _requireActive(phase: string, err: string): FakeGame {
    const game = this._requireLobby().game;
    if (this._readOnly) throw new Error('Avalon is open in another tab');
    if (!game || game.state !== 'ACTIVE' || game.phase !== phase || game.abandoned) throw new Error(err);
    if (!game.seats.some(s => s.name === this._myName())) throw new Error('You are not in this game');
    return game;
  }

  private _gameNonTerminal(): boolean {
    const game = this._lobby?.game;
    return !!game && game.state !== 'ENDED' && !game.abandoned;
  }

  private _defaultRoles(): string[] {
    return ROLES.filter(r => r.selectable && r.selected).map(r => r.name);
  }

  private _history(): FakeHistoryEntry[] {
    try {
      const parsed: unknown = JSON.parse(storageGet(STORAGE_HISTORY) ?? '[]');
      return Array.isArray(parsed) ? parsed as FakeHistoryEntry[] : [];
    } catch {
      return [];
    }
  }

  private _currentMission(game: FakeGame): Mission {
    const m = game.missions.find(x => x.state === 'PENDING');
    if (!m) throw new Error('No mission in progress');
    return m;
  }

  private _currentProposal(game: FakeGame): Proposal {
    const m = this._currentMission(game);
    return m.proposals[m.proposals.length - 1];
  }

  private _bot(game: FakeGame, name: string): boolean {
    return game.seats.find(s => s.name === name)?.bot ?? false;
  }

  /** §3.7 rule 2a: at mt/m with two successes and MERLIN in play, a contributor never cancels. */
  private _rule2a(game: FakeGame): boolean {
    return game.state === 'ACTIVE' && !!game.step && game.step.id.startsWith('mt/') &&
      game.missions.filter(m => m.state === 'SUCCESS').length === 2 &&
      game.seats.some(s => s.role === 'MERLIN') && game.step.done.has(this._myName());
  }

  private _assignRoles(names: string[], selected: string[]): Seat[] {
    const lobby = this._requireLobby();
    const order = shuffle(names);
    const numEvil = getNumEvilForGameSize(names.length) ?? 2;
    const makeTeam = (list: string[], team: 'good' | 'evil'): { name: string; role: Role }[] => {
      const teamRoles = ROLES.filter(r => r.team === team);
      const special = teamRoles.filter(r => selected.includes(r.name)).slice(0, list.length);
      const filler = teamRoles.find(r => r.filler) ?? teamRoles[0];
      return list.map((name, i) => ({ name, role: special[i] ?? filler }));
    };
    const evil = makeTeam(order.slice(0, numEvil), 'evil');
    let assassin: string | null = null;
    if (selected.includes('MERLIN')) {
      assassin = evil.reduce((a, b) => ((b.role.assassinationPriority ?? 0) > (a.role.assassinationPriority ?? 0) ? b : a)).name;
    }
    const all = evil.concat(makeTeam(order.slice(numEvil), 'good'));
    return names.map(name => {
      const a = all.find(x => x.name === name)!;
      const member = lobby.members.find(m => m.name === name)!;
      return { ...member, role: a.role.name, assassin: a.name === assassin };
    });
  }

  private _startGameInternal(lobby: FakeLobby, playerList: string[], roles: string[], options: { inGameLog: boolean }): void {
    const n = playerList.length;
    const sizes = MISSION_SIZES[n];
    const game: FakeGame = {
      seats: this._assignRoles(playerList, roles),
      selectedRoles: roles,
      options: { inGameLog: !!options.inGameLog },
      state: 'INIT', phase: '', setup: null,
      missions: sizes.map((teamSize, i) => ({
        state: 'PENDING', team: [], teamSize, failsRequired: (i === 3 && n >= 7) ? 2 : 1, numFails: 0, proposals: [],
      })),
      proposer: randomInt(n),
      commits: new Map(), ballots: new Map(), missionVotes: [],
      step: null, stalled: new Set(), stallUsed: false, cheatUsed: false,
      outcome: null, terminal: null, revealed: new Set(), terminalAt: 0, startedAt: Date.now(), ended: false,
      lost: this._opts.lost, abandoned: false,
    };
    lobby.game = game;
    this._runSetup(game);
  }

  // ---- steps

  private _beginStep(game: FakeGame, id: string, req: string[]): StepState {
    const step: StepState = { id, req, done: new Set(), since: Date.now() };
    game.step = step;
    const prefix = this._opts.stallAt;
    if (prefix && !game.stallUsed && (id === prefix || id.startsWith(prefix + '/'))) {
      const bots = req.filter(r => this._bot(game, r) && r !== this._myName());
      if (bots.length) {
        game.stallUsed = true;
        game.stalled.add(bots[bots.length - 1]);
      }
    }
    return step;
  }

  /** Bots in req act after a delay unless stalled; `act` is called per bot name. */
  private _botsAct(game: FakeGame, step: StepState, base: number, jitter: number, act: (name: string) => void): void {
    for (const name of step.req) {
      if (!this._bot(game, name) || game.stalled.has(name)) continue;
      this._after(this._ms(base + randomInt(jitter)), () => {
        if (game.step !== step || step.done.has(name) || game.state === 'ENDED') return;
        act(name);
      });
    }
  }

  private _runSetup(game: FakeGame): void {
    const names = game.seats.map(s => s.name);
    const me = this._myName();
    const progressOf = (stage: SetupProgress['stage'], step: StepState, total: number, done: number): SetupProgress =>
      ({ stage, done, total, waitingFor: step.req.filter(r => !step.done.has(r)) });

    const allStage = (stage: SetupProgress['stage'], id: string, next: () => void) => {
      const step = this._beginStep(game, id, names);
      const update = () => { game.setup = progressOf(stage, step, names.length, step.done.size); this._emitAll(); };
      const mark = (name: string) => {
        step.done.add(name);
        update();
        if (step.done.size === names.length) this._after(this._ms(150), next);
      };
      update();
      this._botsAct(game, step, 150, 500, mark);
      if (!game.lost && names.includes(me)) this._after(this._ms(100), () => mark(me));
    };

    const shuffleStage = (j: number) => {
      if (j >= names.length) {
        allStage('deal', 'deal', () => allStage('sight', 'otR', () => allStage('sight', 'otS', () => this._activate(game))));
        return;
      }
      const name = names[j];
      const step = this._beginStep(game, `shuf/${j}`, [name]);
      game.setup = progressOf('shuffle', step, names.length, j);
      this._emitAll();
      const done = () => { step.done.add(name); shuffleStage(j + 1); };
      if (name === me) this._after(this._ms(250), done);
      else this._botsAct(game, step, 200, 300, done);
    };

    allStage('keys', 'key', () => shuffleStage(0));
  }

  private _activate(game: FakeGame): void {
    game.state = 'ACTIVE';
    game.setup = null;
    this._roleEmitter.emit();           // the role is derived before ACTIVE is projected (§11.3)
    this._startProposal(game);
  }

  private _startProposal(game: FakeGame): void {
    const m = game.missions.findIndex(x => x.state === 'PENDING');
    const mission = game.missions[m];
    const p = mission.proposals.length;
    game.phase = 'TEAM_PROPOSAL';
    game.commits = new Map();
    const proposer = game.seats[game.proposer].name;
    mission.proposals.push({ proposer, team: [], votes: [], state: 'PENDING' });
    const step = this._beginStep(game, `p/${m}/${p}`, [proposer]);
    this._emitAll();
    this._botsAct(game, step, 900, 1200, name => {
      const others = shuffle(game.seats.map(s => s.name).filter(x => x !== name));
      this._propose(game, [name, ...others.slice(0, mission.teamSize - 1)]);
    });
  }

  private _seatOrder(game: FakeGame, names: Iterable<string>): string[] {
    const set = new Set(names);
    return game.seats.map(s => s.name).filter(n => set.has(n));
  }

  private _propose(game: FakeGame, names: string[]): void {
    const proposal = this._currentProposal(game);
    proposal.team = this._seatOrder(game, names);
    game.step?.done.add(proposal.proposer);
    game.phase = 'PROPOSAL_VOTE';
    game.commits = new Map();
    const m = game.missions.findIndex(x => x.state === 'PENDING');
    const step = this._beginStep(game, `vc/${m}/${this._currentMission(game).proposals.length - 1}`, game.seats.map(s => s.name));
    this._emitAll();
    const pIdx = this._currentMission(game).proposals.length - 1;
    this._botsAct(game, step, 700, 2500, name => {
      const seat = game.seats.find(s => s.name === name)!;
      const evilOnTeam = proposal.team.some(t => {
        const s = game.seats.find(x => x.name === t);
        return !!s && roleByName(s.role).team === 'evil';
      });
      const approve = pIdx === 4 || (roleByName(seat.role).team === 'evil' ? evilOnTeam || Math.random() < 0.3 : Math.random() < 0.7);
      this._commitVote(game, name, approve);
    });
  }

  private _commitVote(game: FakeGame, name: string, approve: boolean): void {
    const step = game.step;
    if (!step || !step.id.startsWith('vc/')) return;
    game.commits.set(name, approve);
    step.done.add(name);
    this._currentProposal(game).votes = this._seatOrder(game, game.commits.keys());
    this._emitAll();
    if (step.done.size < step.req.length) return;
    // vr: automatic reveals
    const vr = this._beginStep(game, step.id.replace('vc/', 'vr/'), step.req);
    const finish = () => {
      const proposal = this._currentProposal(game);
      const approvers = [...game.commits].filter(([, a]) => a).map(([n]) => n);
      proposal.votes = this._seatOrder(game, approvers);
      const approved = approvers.length >= Math.floor(game.seats.length / 2) + 1;
      proposal.state = approved ? 'APPROVED' : 'REJECTED';
      game.proposer = (game.proposer + 1) % game.seats.length;
      if (approved) {
        this._startMission(game);
      } else if (this._currentMission(game).proposals.length >= 5) {
        this._terminate(game, { state: 'EVIL_WIN', message: 'Five team proposals in a row rejected' });
      } else {
        this._startProposal(game);
      }
    };
    const mark = (n: string) => {
      vr.done.add(n);
      if (vr.done.size === vr.req.length) finish();
      else this._refreshStatus();
    };
    this._botsAct(game, vr, 100, 300, mark);
    if (vr.req.includes(this._myName())) this._after(this._ms(80), () => mark(this._myName()));
  }

  private _startMission(game: FakeGame): void {
    game.phase = 'MISSION_VOTE';
    game.ballots = new Map();
    const m = game.missions.findIndex(x => x.state === 'PENDING');
    const team = this._currentProposal(game).team;
    game.missions[m].team = [];
    const step = this._beginStep(game, `mv/${m}`, team);
    this._emitAll();
    this._botsAct(game, step, 800, 2000, name => {
      const seat = game.seats.find(s => s.name === name)!;
      const evil = roleByName(seat.role).team === 'evil';
      this._castBallot(game, name, !(evil && Math.random() < 0.5));
    });
  }

  private _castBallot(game: FakeGame, name: string, success: boolean): void {
    const step = game.step;
    if (!step || !step.id.startsWith('mv/')) return;
    const seat = game.seats.find(s => s.name === name)!;
    const fail = !success && roleByName(seat.role).team === 'evil';      // good cannot fail
    game.ballots.set(name, fail);
    step.done.add(name);
    const m = game.missions.findIndex(x => x.state === 'PENDING');
    game.missions[m].team = this._seatOrder(game, game.ballots.keys());
    this._emitAll();
    if (step.done.size < step.req.length) return;
    // mt: automatic tally by every seat
    const mt = this._beginStep(game, `mt/${m}`, game.seats.map(s => s.name));
    const finish = () => {
      const mission = game.missions[m];
      if (this._opts.cheat && !game.cheatUsed) {
        game.cheatUsed = true;
        const cheater = game.seats.find(s => s.bot);
        if (cheater) {
          const team = roleByName(cheater.role).team;
          this._terminate(game, {
            state: team === 'evil' ? 'GOOD_WIN' : 'EVIL_WIN',
            message: `${cheater.name} cheated (invalid tally proof); ${team} forfeits`,
            cheaters: [{ name: cheater.name, reason: 'invalid tally proof' }],
          });
          return;
        }
      }
      const numFails = [...game.ballots.values()].filter(f => f).length;
      mission.numFails = numFails;
      mission.team = this._currentProposal(game).team;
      mission.state = numFails >= mission.failsRequired ? 'FAIL' : 'SUCCESS';
      game.missionVotes[m] = Object.fromEntries([...game.ballots].map(([n, f]) => [n, !f]));
      const fails = game.missions.filter(x => x.state === 'FAIL').length;
      const wins = game.missions.filter(x => x.state === 'SUCCESS').length;
      if (fails >= 3) {
        this._terminate(game, { state: 'EVIL_WIN', message: 'Three failed missions' });
      } else if (wins >= 3) {
        if (game.seats.some(s => s.role === 'MERLIN')) this._startAssassination(game);
        else this._terminate(game, { state: 'GOOD_WIN', message: 'Three missions succeeded' });
      } else {
        this._startProposal(game);
      }
    };
    const mark = (n: string) => {
      mt.done.add(n);
      if (mt.done.size === mt.req.length) finish();
      else this._refreshStatus();
    };
    this._botsAct(game, mt, 100, 400, mark);
    this._after(this._ms(80), () => mark(this._myName()));
  }

  private _startAssassination(game: FakeGame): void {
    game.phase = 'ASSASSINATION';
    const assassin = game.seats.find(s => s.assassin)!;
    const step = this._beginStep(game, 'as', [assassin.name]);
    this._emitAll();
    this._botsAct(game, step, 2000, 2000, name => {
      const goods = game.seats.filter(s => s.name !== name && roleByName(s.role).team === 'good');
      const merlin = goods.find(s => s.role === 'MERLIN');
      const target = merlin && Math.random() < 0.4 ? merlin : goods[randomInt(goods.length)];
      this._assassinate(game, target.name);
    });
  }

  private _assassinate(game: FakeGame, target: string): void {
    const merlin = game.seats.find(s => s.role === 'MERLIN');
    if (merlin?.name === target) {
      this._terminate(game, { state: 'EVIL_WIN', message: 'Merlin assassinated', assassinated: target });
    } else {
      this._terminate(game, { state: 'GOOD_WIN', message: 'Three successful missions', assassinated: target });
    }
  }

  // ---- end of game

  private _terminate(game: FakeGame, t: { state: GameOutcome['state']; message: string; assassinated?: string;
                                          canceledBy?: string; stalled?: string[]; cheaters?: { name: string; reason: string }[] }): void {
    if (game.state === 'ENDED') return;
    game.terminal = { ...t, cheaters: t.cheaters ?? [] };
    game.state = 'ENDED';
    game.step = null;
    game.setup = null;
    game.terminalAt = Date.now();
    // Every seat that is still online reveals; stalled bots never do. Stalling at 'reveal' silences two bots.
    if (this._opts.stallAt === 'reveal') {
      game.seats.filter(s => s.bot).slice(-2).forEach(s => game.stalled.add(s.name));
    }
    const me = this._myName();
    if (!game.lost && game.seats.some(s => s.name === me)) game.revealed.add(me);
    game.seats.forEach((s, i) => {
      if (!s.bot || game.stalled.has(s.name)) return;
      this._after(this._ms(400 + 350 * i + randomInt(300)), () => {
        game.revealed.add(s.name);
        this._computeOutcome(game);
        this._emitAll();
      });
    });
    this._after(REVEAL_GIVE_UP_MS, () => this._finishGame(game));
    this._computeOutcome(game);
    this._emitAll();
  }

  /** §5.12 elimination over the fake's reveals. */
  private _computeOutcome(game: FakeGame): void {
    const t = game.terminal;
    if (!t) return;
    const known = new Map<string, Seat>();
    for (const s of game.seats) if (game.revealed.has(s.name)) known.set(s.name, s);
    const unknown = game.seats.filter(s => !known.has(s.name));
    const unresolved = unknown.map(s => s.role + (s.assassin ? '*' : ''));
    const resolveAll = unknown.length === 1 || (unknown.length > 0 && unresolved.every(l => l === unresolved[0]));
    const roles: RoleAssignment[] = game.seats.map(s => {
      const k = known.has(s.name) || resolveAll;
      return { name: s.name, role: k ? s.role : 'UNKNOWN', assassin: k ? s.assassin : false };
    });
    const votes: Record<string, boolean>[] = game.missionVotes.map((mv, m) => {
      const out: Record<string, boolean> = {};
      const team = Object.keys(mv);
      const unknownVoters = team.filter(n => !known.has(n));
      for (const n of team) if (known.has(n)) out[n] = mv[n];
      if (unknownVoters.length === 1) {
        const k = game.missions[m].numFails;
        const knownFails = team.filter(n => known.has(n) && !mv[n]).length;
        out[unknownVoters[0]] = k - knownFails === 0;
      }
      return out;
    });
    const unrevealed = roles.filter(r => r.role === 'UNKNOWN').map(r => r.name);
    for (const [m, mv] of game.missionVotes.entries()) {
      for (const n of Object.keys(mv)) if (!(n in votes[m]) && !unrevealed.includes(n)) unrevealed.push(n);
    }
    let message = t.message;
    let state = t.state;
    if (t.assassinated && roles.find(r => r.name === t.assassinated)?.role === 'UNKNOWN') {
      // whether the target was MERLIN cannot be decided yet (§5.13)
      state = 'CANCELED';
      message = `Assassination unresolved: ${joinWithAnd(unrevealed)} did not reveal`;
    }
    game.outcome = {
      state, message, roles, votes,
      final: unrevealed.length === 0,
      unrevealed: this._seatOrder(game, unrevealed),
      cheaters: t.cheaters,
      ...(t.assassinated ? { assassinated: t.assassinated } : {}),
      ...(t.canceledBy ? { canceledBy: t.canceledBy } : {}),
      ...(t.stalled && t.stalled.length ? { stalled: t.stalled } : {}),
    };
    if (game.revealed.size === game.seats.length) this._finishGame(game);
  }

  private _finishGame(game: FakeGame): void {
    if (game.ended || !game.outcome) return;
    game.ended = true;
    const me = game.seats.find(s => s.name === this._myName());
    const myRole = game.outcome.roles.find(r => r.name === me?.name)?.role;
    if (me && myRole && myRole !== 'UNKNOWN') {
      const entry: FakeHistoryEntry = {
        state: game.outcome.state, team: roleByName(myRole).team,
        seconds: Math.round((game.terminalAt - game.startedAt) / 1000),
      };
      storageSet(STORAGE_HISTORY, JSON.stringify([...this._history(), entry]));
    }
    this._emitAll();
  }

  // ---- projections

  private _projectGame(game: FakeGame | null): GameData {
    if (!game || game.abandoned) return { state: 'INIT', phase: '', players: [], roles: [], missions: [] };
    const data: GameData = {
      state: game.state,
      phase: game.state === 'ACTIVE' ? game.phase : (game.state === 'ENDED' ? game.phase : ''),
      players: game.seats.map(s => s.name),
      roles: game.seats.map(s => s.role).sort(),
      missions: clone(game.missions),
      options: { inGameLog: game.options.inGameLog },
    };
    if (game.state === 'INIT' && game.setup) data.setup = clone(game.setup);
    if (game.state === 'ENDED' && game.outcome) data.outcome = clone(game.outcome);
    return data;
  }

  private _projectLobby(): LobbyData | null {
    const lobby = this._lobby;
    if (!lobby) return null;
    const admin = lobby.members.find(m => m.pub === lobby.admin);
    const users: Record<string, LobbyUser> = {};
    for (const m of lobby.members) users[m.name] = { name: m.name, uid: m.pub };
    return { name: lobby.code, admin: { uid: lobby.admin, name: admin?.name ?? '' }, users, game: this._projectGame(lobby.game) };
  }

  private _projectRole(): RoleDoc | null {
    const game = this._lobby?.game;
    if (!game || game.state === 'INIT' || game.lost || game.abandoned) return null;
    const me = game.seats.find(s => s.name === this._myName());
    if (!me) return null;
    const role = roleByName(me.role);
    const sees = game.seats.filter(s => s.name !== me.name && role.sees.includes(s.role)).map(s => s.name);
    return { role: { ...role }, assassin: me.assassin, sees: shuffle(sees) };
  }

  private _computeStatus(): SessionStatus {
    if (this._readOnly) return { kind: 'READ_ONLY_OTHER_TAB' };
    const game = this._lobby?.game;
    if (!game || game.abandoned) return { kind: 'LOBBY' };
    if (game.state === 'ENDED') {
      return game.ended ? { kind: 'ENDED' } : { kind: 'ENDING', revealed: game.revealed.size, total: game.seats.length };
    }
    if (game.lost) return { kind: 'LOST_SECRETS' };
    const step = game.step;
    if (step) {
      const blocked = step.req.filter(n => !step.done.has(n) && game.stalled.has(n));
      const elapsed = Date.now() - step.since;
      if (blocked.length && elapsed >= 2000) {
        return { kind: 'STALLED', seats: step.req.filter(n => !step.done.has(n)), sinceMs: elapsed };
      }
    }
    if (game.state === 'INIT' && game.setup) {
      return { kind: game.setup.stage === 'keys' ? 'STARTING' : 'SETUP', progress: clone(game.setup) };
    }
    return { kind: 'ACTIVE' };
  }

  private _refreshStatus(): void {
    this._status = this._computeStatus();
    const json = JSON.stringify(this._status);
    if (json !== this._lastStatusJson) {
      this._lastStatusJson = json;
      this._statusEmitter.emit();
    }
  }

  private _tick(): void {
    this._refreshStatus();
  }

  private _emitAll(): void {
    this._profileEmitter.emit();
    this._roleEmitter.emit();
    this._lobbyEmitter.emit();
    this._refreshStatus();
  }

}
