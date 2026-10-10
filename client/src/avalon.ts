import { markRaw } from 'vue'
import { difference, keys, keyBy, values } from 'lodash-es'
import * as avalonLib from '@avalon/common/avalonlib';
import { fingerprintOf } from '@avalon/common/protocol';
import { P2PSession, type SessionStatus, type LocalProfile } from './p2p/session';
import type {
  Role, GameData, GameOutcome, Mission, Proposal, LobbyData, LobbyUser, UserData, RoleDoc, LobbyCandidate, SetupProgress,
} from './types';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Array<T> {
    joinWithAnd(): string;
  }
}

// UI timers of docs/p2p-protocol.md §7.8 (they only drive the UI, never the protocol).
export const UI_TIMERS = {
  reconnectingMs: 3000,            // socket down > 3 s: "Reconnecting..."
  offlineMs: 30000,                // socket down > 30 s: "Offline - your moves are saved ..."
  listBlockersMs: 10000,           // automatic step pending > 10 s: list blocking seats
  emphasizeCancelMs: 60000,        // pending > 60 s: Cancel emphasized
  emphasizeCancelShuffleMs: 45000, // shuffle pending > 45 s: Cancel emphasized
  abortStartMs: 30000,             // key incomplete > 30 s: admin "[Abort start]"
  suggestCancelMs: 180000,         // human step whose actor is offline > 3 min: suggest Cancel
  abandonAssassinationMs: 180000,  // assassin offline > 3 min: "[Abandon]"
  abandonRule2aMs: 60000,          // rule-2a mt/m pending > 60 s with own tally: "[Abandon]"
  takeOverMs: 60000,               // admin presence missing > 60 s: "[Take over as admin]"
  missingRevealsMs: 60000,         // terminal, reveals missing after 60 s: "NAME did not reveal"
  showEndAfterMs: 20000,           // GAME_ENDED once everyone revealed or 20 s passed (§5.12)
} as const;

const PREFERRED_NAME_KEY = 'avalon-preferred-name';

function nowMs(): number {
  return performance.now();
}

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // per-viewer convenience only
  }
}

class Game {
  game: GameData;
  roleInfos: Role[] | undefined;
  roleMap!: Record<string, Role>;
  numPlayers!: number;
  currentMissionIdx!: number;
  currentMission: Mission | null = null;
  currentProposalIdx!: number;
  currentProposal: Proposal | null = null;
  currentProposer: string | null = null;
  hammer: string | null = null;

  // Properties copied from GameData via Object.assign
  state!: GameData['state'];
  phase!: string;
  players!: string[];
  roles!: string[];
  missions!: Mission[];
  outcome?: GameOutcome;
  options?: GameData['options'];
  setup?: SetupProgress;

  constructor(game: GameData, config: GameConfig) {
    this.game = game;
    if (game.roles) {
      const roleIndexOf = (name: string) => config.roles.findIndex(r => r.name == name);
      // sort a copy: the snapshot belongs to the session
      this.roleInfos = game.roles.slice().sort((a, b) => roleIndexOf(a) - roleIndexOf(b))
        .map(r => config.roleMap[r]).filter((r): r is Role => !!r);
    }
    Object.assign(this, game);
    this.roleMap = config.roleMap;

    if (this.state == 'INIT') {
      return;
    }
    this.numPlayers = this.game.players.length;
    this.currentMissionIdx = this.missions.findIndex(m => m.state == 'PENDING');
    if (this.currentMissionIdx < 0) {
      this.currentMission = null;
      this.currentProposalIdx = -1;
      this.currentProposal = null;
      this.currentProposer = null;
      this.hammer = null;
    } else {
      this.currentMission = this.missions[this.currentMissionIdx];
      this.currentProposalIdx = this.currentMission.proposals.findIndex(p => p.state == 'PENDING');
      if (this.currentProposalIdx < 0) {
        // no pending proposals, so must be latest one
        this.currentProposalIdx = this.currentMission.proposals.length - 1;
      }
      this.currentProposal = this.missions[this.currentMissionIdx].proposals[this.currentProposalIdx] ?? null;
      this.currentProposer = (this.currentProposal ? this.currentProposal.proposer : null);

      if (this.currentProposal != null) {
        const proposerIdx = this.game.players.findIndex(p => p == this.currentProposer);
        const hammerIdx = (proposerIdx + (4 - this.currentProposalIdx)) % this.numPlayers;
        this.hammer = this.game.players[hammerIdx];
      } else {
        this.hammer = null;
      }
    }
  }

  get lastProposal(): Proposal | null {
    if (this.currentProposalIdx > 0) {
      return this.missions[this.currentMissionIdx].proposals[this.currentProposalIdx - 1];
    }
    if (this.currentMissionIdx <= 0) {
      return null;
    }
    return this.missions[this.currentMissionIdx - 1].proposals.find(p => p.state == 'APPROVED') ?? null;
  }

  getNumTeam(team: string): number {
    return this.game.roles.filter(r => this.roleMap[r]?.team == team).length;
  }

  get numEvil(): number {
    return this.getNumTeam('evil');
  }

  get numGood(): number {
    return this.getNumTeam('good');
  }
}

class LobbySubscription {
  name: string;
  connected: boolean;
  lobbyId: string | null;
  private _session: P2PSession;
  private _doc: LobbyData | null;
  private _roleDoc: RoleDoc | null;
  private _game: Game | null;
  private _config: GameConfig;
  private _eventHandler: (evt: string) => void;
  private _unsubscribes: (() => void)[];

  constructor(session: P2PSession, lobbyName: string, config: GameConfig, eventHandler: (evt: string) => void) {
    this.name = lobbyName;
    this.lobbyId = null;
    this._session = session;
    this._doc = null;
    this._roleDoc = null;
    this._game = null;
    this._config = config;
    this.connected = false;
    this._eventHandler = eventHandler;
    this._unsubscribes = [];
  }

  get data(): LobbyData {
    return this._doc!;
  }

  get users(): Record<string, LobbyUser> {
    return this.data.users;
  }

  get admin(): { uid: string; name: string } {
    return this.data.admin;
  }

  get game(): Game {
    return this._game!;
  }

  get role(): RoleDoc | null {
    return this._roleDoc;
  }

  /** Lobby fingerprint shown for verbal confirmation (§4.1): CODE · first 32 bits of lobbyId (XXXX-XXXX). */
  get fingerprint(): string | null {
    return this.lobbyId ? fingerprintOf(this.lobbyId) : null;
  }

  /**
   * Invite link (§4.1). Without a known lobbyId it carries only the code. The admin's link also
   * carries the invite key (`k`): joins through it are admitted automatically, joins by code alone
   * wait for the admin's approval (§4.3).
   */
  get inviteLink(): string {
    const base = window.location.origin + '/?lobby=' + encodeURIComponent(this.name);
    if (!this.lobbyId) return base;
    const key = this._session.invite()?.key ?? null;
    return base + '&id=' + this.lobbyId.slice(0, 16) + (key ? '&k=' + key : '');
  }

  /** Admin: join requests without an invite ticket, waiting for approval. */
  get requests(): { joinId: string; name: string }[] {
    return this._doc?.requests ?? [];
  }

  start(): void {
    // role first: ACTIVE is projected only after this seat's role is derived (§11.3)
    this._unsubscribes.push(this._session.onRole(this._roleDocUpdated.bind(this)));
    this._unsubscribes.push(this._session.onLobby(this._lobbyDocUpdated.bind(this)));
  }

  stop(): void {
    for (const unsubscribe of this._unsubscribes) unsubscribe();
    this._unsubscribes = [];
    this.connected = false;
  }

  private _roleDocUpdated(roleDoc: RoleDoc | null): void {
    if (roleDoc) {
      // keep the identity of the config's Role objects (RoleList, roleMap lookups)
      this._roleDoc = { ...roleDoc, role: this._config.roleMap[roleDoc.role.name] ?? roleDoc.role, sees: roleDoc.sees ?? [] };
    } else {
      this._roleDoc = null;
    }
  }

  private _lobbyDocUpdated(newDoc: LobbyData | null): void {
    const oldDoc = this._doc;

    if (newDoc == null) {
      // Not (yet) known to the session. Leaving and kicks arrive as a profile without a lobby.
      return;
    }

    this._doc = newDoc;
    this._game = new Game(newDoc.game, this._config);
    const invite = this._session.invite();
    if (invite && invite.code == this.name) this.lobbyId = invite.lobbyId;

    if ((oldDoc == null) ||
        (oldDoc.name != newDoc.name)) {
      this.connected = true;
      this._eventHandler('LOBBY_CONNECTED');
      return;
    }

    if (oldDoc.admin.uid != newDoc.admin.uid) {
      this._eventHandler('LOBBY_NEW_ADMIN');
    }

    if ((keys(oldDoc.users).length != keys(newDoc.users).length) ||
        !keys(oldDoc.users).every(u => newDoc.users[u])) {
      this._eventHandler('PLAYER_LIST_CHANGED');
    }

    if (oldDoc.game.state != newDoc.game.state) {
      if (newDoc.game.state == 'ACTIVE') {
        this._eventHandler('GAME_STARTED');
      } else if (newDoc.game.state == 'ENDED') {
        this._eventHandler('GAME_ENDED');
      }
      if (oldDoc.game.state == 'ENDED' && newDoc.game.state != 'ENDED' && newDoc.game.state != 'ACTIVE') {
        // ENDED -> INIT: the admin published a new config; the setup progress shows in the lobby view,
        // and the previous game's end screens close.
        this._eventHandler('GAME_SETUP');
      }
    } else if (oldDoc.game.phase != newDoc.game.phase && newDoc.game.state == 'ACTIVE') {
      if (this.game.phase == 'TEAM_PROPOSAL') {
        if (this.game.currentProposalIdx > 0) {
          this._eventHandler('PROPOSAL_REJECTED');
        } else {
          this._eventHandler('MISSION_RESULT');
        }
      } else if (this.game.phase == 'ASSASSINATION') {
        this._eventHandler('MISSION_RESULT');
      } else if (this.game.phase == 'MISSION_VOTE') {
        this._eventHandler('PROPOSAL_APPROVED');
      } else if (this.game.phase == 'PROPOSAL_VOTE') {
        this._eventHandler('TEAM_PROPOSED');
      } else {
        console.warn('No mapped event for', this.game.phase);
      }
    }
  }
}

class GameConfig {
  playerList: string[];
  roles!: Role[];
  selectableRoles!: Role[];
  roleMap!: Record<string, Role>;
  notifyEvent: (event: string, data?: string) => void;

  constructor(notificationCallback: (event: string, data?: string) => void) {
    this.playerList = [];
    this.setupRoles();
    this.notifyEvent = notificationCallback;
  }

  get selectedRoleList(): string[] {
    // updateRoles() marks the previous game's deck, fillers included; a config carries only
    // selectable roles (§4.6: selectedRoles ⊆ selectable role names, in ROLES order)
    return this.roles.filter(r => r.selected && r.selectable).map(r => r.name);
  }

  sortList(newList: string[]): void {
    console.assert(newList.length == this.playerList.length);
    this.playerList = newList;
  }

  roleDescription(role: string): Role {
    return this.roleMap[role];
  }

  updatePlayerList(newList: Record<string, LobbyUser>, notifyForEachPlayer: boolean): void {
    const nameList: string[] = values(newList).map(u => u.name);

    if (this.playerList.length == 0) {
      this.playerList = nameList;
      return;
    }

    const removedPlayers = difference(this.playerList, nameList);
    const newPlayers = difference(nameList, this.playerList);

    removedPlayers.forEach(r => {
      this.playerList.splice(this.playerList.indexOf(r), 1);
      if (notifyForEachPlayer) this.notifyEvent('PLAYER_LEFT', r);
    });

    this.playerList = this.playerList.concat(newPlayers);
    if (notifyForEachPlayer) {
      newPlayers.forEach(p => this.notifyEvent('PLAYER_JOINED', p));
    }
  }

  updateRoles(roles: string[]): void {
    this.roles.forEach(r => r.selected = false);
    roles.forEach(r => { if (this.roleMap[r]) this.roleMap[r].selected = true; });
  }

  setupRoles(): void {
    this.roles = avalonLib.ROLES;
    this.selectableRoles = this.roles.filter(r => r.selectable);
    this.roleMap = keyBy(this.roles, r => r.name) as Record<string, Role>;
  }
}

/**
 * The API the Vue components use (docs/p2p-protocol.md §11.3), on top of P2PSession (§11.2).
 *
 * Methods must be called through the reactive proxy Vue wraps this object in (`this.avalon.x()`),
 * so that callbacks registered with the session write through the proxy and trigger re-renders.
 * The session itself is kept out of reactivity with markRaw (§7.1).
 */
export default class AvalonGame {
  lobby: LobbySubscription | null;
  user: UserData | null;
  globalStats: null;
  config: GameConfig;
  confirmingEmailError: null;
  /** Session status (§7.8); drives ConnectionBanner and the stall notices. */
  status: SessionStatus;
  /** Relay connection state, polled once per second. */
  connected: boolean;
  /** performance.now(), refreshed once per second so that timer-based UI re-renders. */
  now: number;
  /** Name chosen on the login screen, used to prefill the lobby screen. */
  preferredName: string;
  private _session: P2PSession | null;
  private _sessionOpened: boolean;
  private _eventCallback: ((event: string, data?: string) => void) | null;
  private _leaving: boolean;
  private _disconnectedAt: number | null;
  private _stalledAt: number | null;
  private _stalledKey: string;
  private _setupAt: number | null;
  private _setupStageKey: string;
  private _terminalAt: number | null;
  private _endPending: boolean;

  constructor(eventCallback: (event: string, data?: string) => void) {
    // XXX TODO: find a better place for this:
    Array.prototype.joinWithAnd = function() {
      if (this.length == 0) return '';
      if (this.length == 1) return this[0];
      const arrCopy = this.slice(0);
      const lastElem = arrCopy.pop();
      return arrCopy.join(', ') + ' and ' + lastElem;
    };

    this.lobby = null;
    this.user = null;
    this.globalStats = null;
    this.confirmingEmailError = null;
    this.status = { kind: 'CONNECTING' };
    this.connected = false;
    this.now = nowMs();
    this.preferredName = storageGet(PREFERRED_NAME_KEY) ?? '';
    this._session = null;
    this._sessionOpened = false;
    this._leaving = false;
    this._disconnectedAt = null;
    this._stalledAt = null;
    this._stalledKey = '';
    this._setupAt = null;
    this._setupStageKey = '';
    this._terminalAt = null;
    this._endPending = false;

    this._eventCallback = eventCallback;
    this.config = new GameConfig(this.notifyEvent.bind(this));
  }

  notifyEvent(event: string, data?: string): void {
    if (this._eventCallback) {
      this._eventCallback(event, data);
    } else {
      console.warn("(no event callback)", event, data);
    }
  }

  private get session(): P2PSession {
    if (!this._session) throw new Error('Still connecting');
    return this._session;
  }

  // ------------------------------------------------------------------ lobby actions

  /** Discovery for the join screen (§4.3): candidates for a 4-letter code. */
  findLobbies(code: string): Promise<LobbyCandidate[]> {
    return this.session.findLobbies(code);
  }

  async joinLobby(name: string, lobby: string, lobbyId?: string, inviteKey?: string): Promise<void> {
    const resp = await this.session.joinLobby(name, lobby, lobbyId, inviteKey);
    this.subscribeToLobby(resp.lobby);
    if (lobbyId && this.lobby && this.lobby.name == resp.lobby) this.lobby.lobbyId = lobbyId;
  }

  async createLobby(name: string): Promise<void> {
    const resp = await this.session.createLobby(name);
    this.subscribeToLobby(resp.lobby);
  }

  async leaveLobby(): Promise<void> {
    this._leaving = true;
    try {
      await this.session.leaveLobby();
      this.unsubscribeFromLobby();
    } finally {
      this._leaving = false;
    }
    void this._refreshStats();
  }

  /** Admin: admit a join request that came without an invite link (§4.3). */
  approveJoin(joinId: string): void {
    this.session.approveJoin(joinId);
  }

  /** Admin: decline a join request. */
  declineJoin(joinId: string): void {
    this.session.declineJoin(joinId);
  }

  kickPlayer(name: string): Promise<void> {
    return this.session.kickPlayer(name);
  }

  takeOverAdmin(): Promise<void> {
    return this.session.takeOverAdmin();
  }

  startGame(options: { inGameLog?: boolean }): Promise<void> {
    return this.session.startGame(this.config.playerList, this.config.selectedRoleList, { inGameLog: !!options.inGameLog });
  }

  cancelGame(): Promise<void> {
    return this.session.cancelGame();
  }

  /** Local only (§3.7 rule 6, §7.8): stop waiting, publish nothing, reveal nothing. */
  abandonGame(): Promise<void> {
    return this.session.abandonGame();
  }

  /** READ_ONLY_OTHER_TAB: take the single-writer lock from the other tab (§3.9). */
  useHere(): Promise<void> {
    return this.session.useHere();
  }

  // ------------------------------------------------------------------ game actions

  voteTeam(vote: boolean): Promise<void> {
    return this.session.voteTeam(vote);
  }

  proposeTeam(playerList: string[]): Promise<void> {
    return this.session.proposeTeam(playerList);
  }

  doMission(vote: boolean): Promise<void> {
    return this.session.doMission(vote);
  }

  assassinate(target: string): Promise<void> {
    return this.session.assassinate(target);
  }

  // ------------------------------------------------------------------ state for components

  get initialized(): boolean {
    if (!this._sessionOpened) {
      return false;
    }

    // A read-only tab (another tab holds the driver lock, §3.9) never loads the lobby: it shows the
    // read-only notice with "Use here" instead.
    if (this.isReadOnly) return true;

    // either not logged in or if logged in, then we're not in lobby or we've loaded the lobby already
    return (this.user == null) || !this.user.lobby || this.isInLobby;
  }

  get isLoggedIn(): boolean {
    return (this.initialized && (this.user != null));
  }

  get isAdmin(): boolean {
    return this.isInLobby && (this.lobby!.admin.uid == this.user!.uid);
  }

  get isInLobby(): boolean {
    return !!(this.user && this.user.lobby && this.lobby && this.lobby.connected);
  }

  get isGameInProgress(): boolean {
    return this.isInLobby && this.lobby!.game.state == 'ACTIVE' && (this.lobby!.role != null);
  }

  /** Setup in progress or ACTIVE (a game can be canceled while the cards are being dealt). */
  get isGameRunning(): boolean {
    if (!this.isInLobby) return false;
    const game = this.lobby!.game;
    return game.state == 'ACTIVE' || (game.state == 'INIT' && !!game.setup) ||
      this.status.kind == 'STARTING' || this.status.kind == 'SETUP' || this.status.kind == 'LOST_SECRETS';
  }

  /** This device is seated in the lobby's current game. */
  get isPlayer(): boolean {
    return this.isInLobby && !!this.user && this.lobby!.game.players.includes(this.user.name);
  }

  get game(): Game {
    return this.lobby!.game;
  }

  get isReadOnly(): boolean {
    return this.status.kind == 'READ_ONLY_OTHER_TAB';
  }

  /** Setup progress (§11.3): from the projected game, or from the STARTING/SETUP status. */
  get setupProgress(): SetupProgress | null {
    if (this.isInLobby && this.lobby!.game.state == 'INIT' && this.lobby!.game.setup) return this.lobby!.game.setup;
    if (this.status.kind == 'STARTING' || this.status.kind == 'SETUP') return this.status.progress;
    return null;
  }

  /** Milliseconds the current setup stage has been pending locally. */
  get setupStageMs(): number {
    return this._setupAt == null ? 0 : this.now - this._setupAt;
  }

  get stalledSeats(): string[] {
    return this.status.kind == 'STALLED' ? this.status.seats : [];
  }

  /** Milliseconds the stalled step has been pending (0 when nothing is stalled). */
  get stalledMs(): number {
    return (this.status.kind == 'STALLED' && this._stalledAt != null) ? Math.max(0, this.now - this._stalledAt) : 0;
  }

  /** Socket down for this many ms (0 when connected). */
  get disconnectedMs(): number {
    return this._disconnectedAt == null ? 0 : this.now - this._disconnectedAt;
  }

  /** The game is terminal but the end screen still waits for the reveals (at most 20 s, §5.12): "ending". */
  get isEnding(): boolean {
    return this._endPending;
  }

  get endingProgress(): { revealed: number; total: number } | null {
    return this.status.kind == 'ENDING' ? { revealed: this.status.revealed, total: this.status.total } : null;
  }

  /** Milliseconds since the outcome became terminal on this device. */
  get endedMs(): number {
    return this._terminalAt == null ? 0 : this.now - this._terminalAt;
  }

  /**
   * §3.7 rule 2a / §7.7: at the mt/m that can lead to the assassination (two successful missions, MERLIN in
   * play), once all ballots are in this device's tally is published automatically, and canceling would be
   * "canceled and continued". The UI then offers only Leave/Abandon. (The session refuses the cancel too.)
   */
  get cancelWouldForfeit(): boolean {
    if (!this.isGameInProgress) return false;
    const game = this.game;
    const mission = game.currentMission;
    return game.phase == 'MISSION_VOTE' && !!mission && mission.team.length >= mission.teamSize &&
      game.missions.filter(m => m.state == 'SUCCESS').length == 2 && game.roles.includes('MERLIN') && this.isPlayer;
  }

  /** §7.8: Abandon is offered when the assassin is away > 3 min, or at a rule-2a step pending > 60 s. */
  get canAbandon(): boolean {
    if (!this.isGameInProgress || this.status.kind != 'STALLED') return false;
    if (this.game.phase == 'ASSASSINATION') return this.stalledMs > UI_TIMERS.abandonAssassinationMs;
    return this.cancelWouldForfeit && this.stalledMs > UI_TIMERS.abandonRule2aMs;
  }

  /**
   * §4.5/§7.8: "[Take over as admin]" for the first non-admin member only, when the admin's device has been
   * away for 60 s. P2PSession exposes no presence, so "away" is approximated by the admin blocking a stalled step.
   */
  get canTakeOver(): boolean {
    if (!this.isInLobby || this.isAdmin || !this.user) return false;
    const admin = this.lobby!.admin;
    const firstOther = values(this.lobby!.users).map(u => u.name).find(n => n != admin.name);
    return firstOther == this.user.name && this.stalledSeats.includes(admin.name) && this.stalledMs > UI_TIMERS.takeOverMs;
  }

  // ------------------------------------------------------------------ session wiring

  private _profileUpdated(profile: LocalProfile | null): void {
    if (profile == null) {
      this.unsubscribeFromLobby();
      this.user = null;
      return;
    }

    const uidChanged = !this.user || this.user.uid != profile.uid;
    this.user = {
      uid: profile.uid,
      name: profile.name ?? this.preferredName,
      email: null,
      lobby: profile.lobby,
      stats: uidChanged ? null : this.user!.stats,
    };
    if (uidChanged) void this._refreshStats();

    if (!profile.lobby && (this.lobby != null)) {
      const oldLobby = this.lobby.name;
      this.unsubscribeFromLobby();
      if (!this._leaving) {
        // kicked, or the lobby was closed
        this.notifyEvent('DISCONNECTED_FROM_LOBBY', oldLobby);
      }
    }

    if (profile.lobby && (this.lobby == null)) {
      this.subscribeToLobby(profile.lobby);
    }
  }

  private _statusUpdated(status: SessionStatus): void {
    const now = nowMs();
    if (status.kind == 'STALLED') {
      const key = status.seats.join(',');
      if (this.status.kind != 'STALLED' || key != this._stalledKey || this._stalledAt == null) {
        this._stalledAt = now - status.sinceMs;
        this._stalledKey = key;
      }
    } else {
      this._stalledAt = null;
      this._stalledKey = '';
    }
    if (status.kind == 'ENDING' && this._terminalAt == null) {
      this._terminalAt = now;
    }
    this.status = status;
    this._trackSetup();
    this._flushEnd();
  }

  private _trackSetup(): void {
    const progress = this.setupProgress;
    const key = progress ? progress.stage + '/' + (progress.stage == 'shuffle' ? progress.done : '') : '';
    if (key != this._setupStageKey) {
      this._setupStageKey = key;
      this._setupAt = progress ? nowMs() : null;
    }
  }

  private _tick(): void {
    this.now = nowMs();
    const connected = this._session ? this._session.connected : false;
    if (connected != this.connected) this.connected = connected;
    if (connected) {
      this._disconnectedAt = null;
    } else if (this._disconnectedAt == null) {
      this._disconnectedAt = this.now;
    }
    this._flushEnd();
  }

  /** §5.12: GAME_ENDED fires when every seat has revealed or 20 s have passed locally. */
  private _shouldDeferEnd(): boolean {
    if (!this.isInLobby || this._terminalAt == null) return false;
    if (nowMs() - this._terminalAt >= UI_TIMERS.showEndAfterMs) return false;
    if (this.status.kind == 'ENDING') return this.status.revealed < this.status.total;
    const outcome = this.lobby!.game.outcome;
    return !!outcome && !outcome.final && outcome.unrevealed.length > 0 && this.status.kind != 'ENDED';
  }

  private _flushEnd(): void {
    if (this._endPending && !this._shouldDeferEnd()) {
      this._endPending = false;
      this.notifyEvent('GAME_ENDED');
      void this._refreshStats();
    }
  }

  private async _refreshStats(): Promise<void> {
    if (!this._session || !this.user) return;
    try {
      const stats = await this._session.userStats();
      if (this.user) this.user.stats = stats;
    } catch (err) {
      console.warn('could not compute stats', err);
    }
  }

  /** Learn the lobbyId of a lobby we created (fingerprint and invite link, §4.1). */
  private async _resolveLobbyId(code: string): Promise<void> {
    const sub = this.lobby;
    if (!sub || sub.lobbyId || !this._session) return;
    try {
      const candidates = await this._session.findLobbies(code);
      const admin = sub.connected ? sub.admin.uid : null;
      const mine = candidates.filter(c => c.code == code && (admin == null || c.adminPub == admin) &&
        (!this.user || c.members.includes(this.user.name)));
      if (mine.length == 1 && this.lobby === sub) sub.lobbyId = mine[0].lobbyId;
    } catch (err) {
      console.debug('lobby id lookup failed', err);
    }
  }

  unsubscribeFromLobby(): void {
    if (this.lobby != null) {
      this.lobby.stop();
      this.lobby = null;
    }
    this._endPending = false;
    this._terminalAt = null;
  }

  subscribeToLobby(lobby: string): void {
    if (this.lobby != null) {
      // want to avoid double-subscriptions (from profile and create/join func calls)
      return;
    }
    this.lobby = new LobbySubscription(this.session, lobby, this.config, (evt: string) => this._lobbyEvent(evt));
    this.lobby.start();
  }

  private _lobbyEvent(evt: string): void {
    switch (evt) {
      case 'LOBBY_CONNECTED':
        this.lobbyConnected();
        break;
      case 'GAME_STARTED':
        this._endPending = false;
        this._terminalAt = null;
        this.config.updateRoles(this.lobby!.game.roles);
        break;
      case 'GAME_ENDED':
        if (this._terminalAt == null) this._terminalAt = nowMs();
        if (this._shouldDeferEnd()) {
          this._endPending = true;
          return;
        }
        void this._refreshStats();
        break;
      case 'PLAYER_LIST_CHANGED':
        this.config.updatePlayerList(this.lobby!.users, true);
        break;
      default:
        console.debug('received', evt, 'in avalon game engine');
    }
    this._trackSetup();
    this.notifyEvent(evt);
    this._flushEnd();
  }

  lobbyConnected(): void {
    this.config.updatePlayerList(this.lobby!.users, false);
    // a lobby without a game projects roles: [] (§4.7); keep the default role selection then
    if (this.lobby!.game.roles && this.lobby!.game.roles.length) {
      this.config.updateRoles(this.lobby!.game.roles);
    }
    if (this.lobby!.game.state == 'ENDED') {
      // reconnecting to a finished game: its end screen was already shown (or never will be)
      this._terminalAt = nowMs() - UI_TIMERS.showEndAfterMs;
    }
    void this._resolveLobbyId(this.lobby!.name);
  }

  /** Chosen name on the login screen ("choose a name"), then the device key pair is created. */
  async signInAnonymously(name?: string): Promise<void> {
    if (name) {
      this.preferredName = name;
      storageSet(PREFERRED_NAME_KEY, name);
    }
    await this.session.createIdentity();
  }

  /** Leave the lobby if any, then forget this device's key pair (refused while a game is non-terminal). */
  async logout(): Promise<void> {
    if (this.isInLobby) {
      await this.leaveLobby();
    }
    await this.session.resetIdentity();
  }

  async init(): Promise<void> {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has("purchaseSuccess")) {
      alert('Thank you. Your support means a lot.');
    } else if (urlParams.has('purchaseCanceled')) {
      alert('Maybe next time?');
    }

    const session = markRaw(await P2PSession.open());
    this._session = session;
    this.connected = session.connected;
    this.status = session.status;
    session.onStatus(status => this._statusUpdated(status));
    session.onProfile(profile => this._profileUpdated(profile));
    if (this.user == null && session.profile) this._profileUpdated(session.profile);
    this._sessionOpened = true;
    setInterval(() => this._tick(), 1000);
    this._tick();
  }
}
