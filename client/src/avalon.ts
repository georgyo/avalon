import _ from 'lodash'
import { RecordId, Table } from 'surrealdb'
import * as avalonLib from '@avalon/common/avalonlib';
import { AvalonApi } from './avalon-api-rest';
import { db, connectDb } from './surrealdb';
import { signupAnonymous, signupWithEmail, signinWithEmail, signout, getToken, restoreSession, getUserIdFromToken } from './auth';
import type { Role, GameData, Mission, Proposal, LobbyData, LobbyUser, UserData, RoleDoc } from './types';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Array<T> {
    joinWithAnd(): string;
  }
}

function onSurrealError(err: Error): void {
  console.error(err);
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
  outcome?: GameData['outcome'];
  options?: GameData['options'];

  constructor(game: GameData, config: GameConfig) {
    this.game = game;
    if (game.roles) {
      this.roleInfos = game.roles.sort(
        (a: string, b: string) => {
          const roleIndexOf = (name: string) => config.roles.findIndex(r => r.name == name);
          return roleIndexOf(a) - roleIndexOf(b);
        }).map((r: string) => config.roleMap[r]);
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
      this.currentProposal = this.missions[this.currentMissionIdx].proposals[this.currentProposalIdx];
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
    return this.game.roles.filter(r => this.roleMap[r].team == team).length;
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
  private _uid: string;
  private _doc: LobbyData | null;
  private _roleDoc: RoleDoc | null;
  private _game: Game | null;
  private _config: GameConfig;
  private _eventHandler: (evt: string) => void;
  private _liveQueryIds: string[];
  private _pollInterval: ReturnType<typeof setInterval> | null;

  constructor(uid: string, lobbyName: string, config: GameConfig, eventHandler: (evt: string) => void) {
    this.name = lobbyName;
    this._uid = uid;
    this._doc = null;
    this._roleDoc = null;
    this._game = null;
    this._config = config;
    this.connected = false;
    this._eventHandler = eventHandler;
    this._liveQueryIds = [];
    this._pollInterval = null;
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

  async start(): Promise<void> {
    // Initial fetch of lobby data
    try {
      const lobbyResult = await db.query<[LobbyData[]]>(
        `SELECT * FROM lobby WHERE id = type::thing('lobby', $name)`,
        { name: this.name }
      );
      const lobbyData = lobbyResult[0]?.[0];
      if (lobbyData) {
        this._lobbyDataUpdated(lobbyData);
      }
    } catch (err) {
      onSurrealError(err as Error);
    }

    // Initial fetch of role data
    try {
      const roleResult = await db.query<[{ role: string; sees?: string[] }[]]>(
        'SELECT * FROM player_role WHERE lobby = $lobby AND user = $uid',
        { lobby: new RecordId('lobby', this.name), uid: new RecordId('user', this._uid) }
      );
      const roleData = roleResult[0]?.[0];
      this._roleDataUpdated(roleData ?? null);
    } catch (err) {
      onSurrealError(err as Error);
    }

    // Set up live queries for real-time updates
    try {
      const lobbyLive = await db.live(new Table('lobby'));
      lobbyLive.subscribe((action, result) => {
        if (action === 'CLOSE') return;
        if (!result) return;
        // Filter to our lobby
        const record = result as LobbyData & { id: { id: string } | string };
        const recordId = typeof record.id === 'object' ? String(record.id) : String(record.id);
        if (recordId.includes(this.name) || (record as LobbyData & { id: string }).id === this.name) {
          if (action === 'DELETE') {
            console.error('lobby', this.name, 'disappeared from underneath us');
            this.stop();
            return;
          }
          this._lobbyDataUpdated(record);
        }
      });
      this._liveQueryIds.push('lobby');
    } catch (err) {
      console.warn('Live query for lobby failed, falling back to polling:', err);
    }

    try {
      const roleLive = await db.live(new Table('player_role'));
      roleLive.subscribe((action, result) => {
        if (action === 'CLOSE') return;
        if (!result) return;
        const record = result as { lobby: unknown; user: unknown; role: string; sees?: string[] };
        const lobbyStr = String(record.lobby);
        if (lobbyStr === this.name || lobbyStr.includes(this.name)) {
          if (action === 'DELETE') {
            this._roleDataUpdated(null);
          } else {
            this._roleDataUpdated(record);
          }
        }
      });
      this._liveQueryIds.push('player_role');
    } catch (err) {
      console.warn('Live query for player_role failed, falling back to polling:', err);
    }

    // Polling fallback: periodically re-fetch in case live queries miss updates
    this._pollInterval = setInterval(async () => {
      try {
        const lobbyResult = await db.query<[LobbyData[]]>(
          `SELECT * FROM lobby WHERE id = type::thing('lobby', $name)`,
          { name: this.name }
        );
        const lobbyData = lobbyResult[0]?.[0];
        if (lobbyData) {
          this._lobbyDataUpdated(lobbyData);
        }

        const roleResult = await db.query<[{ role: string; sees?: string[] }[]]>(
          'SELECT * FROM player_role WHERE lobby = $lobby AND user = $uid',
          { lobby: new RecordId('lobby', this.name), uid: new RecordId('user', this._uid) }
        );
        const roleData = roleResult[0]?.[0];
        this._roleDataUpdated(roleData ?? null);
      } catch {
        // ignore polling errors
      }
    }, 2000);
  }

  stop(): void {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }

    // Live queries will be cleaned up when connection is dropped or invalidated
    this._liveQueryIds = [];
    this.connected = false;
  }

  private _roleDataUpdated(rawData: { role: string; sees?: string[] } | null): void {
    if (rawData) {
      this._roleDoc = { ...rawData, role: this._config.roleMap[rawData.role] };
    } else {
      this._roleDoc = null;
    }
  }

  private _lobbyDataUpdated(newData: LobbyData): void {
    const oldDoc = this._doc;

    this._doc = newData;
    this._game = new Game(this._doc.game, this._config);

    if ((oldDoc == null) ||
        (oldDoc.name != this._doc.name)) {
      this.connected = true;
      this._eventHandler('LOBBY_CONNECTED');
      return;
    }

    if (oldDoc.admin.uid != newData.admin.uid) {
      this._eventHandler('LOBBY_NEW_ADMIN');
    }

    if ((_.keys(oldDoc.users).length != _.keys(newData.users).length) ||
        !_.keys(oldDoc.users).every(u => newData.users[u])) {
      this._eventHandler('PLAYER_LIST_CHANGED');
    }

    if (oldDoc.game.state != newData.game.state) {
      this._eventHandler(
        newData.game.state == 'ACTIVE' ? 'GAME_STARTED' : 'GAME_ENDED'
      );
    } else if (oldDoc.game.phase != newData.game.phase) {
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
    return this.roles.filter(r => r.selected).map(r => r.name);
  }

  sortList(newList: string[]): void {
    console.assert(newList.length == this.playerList.length);
    this.playerList = newList;
  }

  roleDescription(role: string): Role {
    return this.roleMap[role];
  }

  updatePlayerList(newList: Record<string, LobbyUser>, notifyForEachPlayer: boolean): void {
    const nameList: string[] = _.values(newList).map(u => u.name);

    if (this.playerList.length == 0) {
      this.playerList = nameList;
      return;
    }

    const removedPlayers = _.difference(this.playerList, nameList);
    const newPlayers = _.difference(nameList, this.playerList);

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
    roles.forEach(r => this.roleMap[r].selected = true);
  }

  setupRoles(): void {
    this.roles = avalonLib.ROLES;
    this.selectableRoles = this.roles.filter(r => r.selectable);
    this.roleMap = _.keyBy(this.roles, r => r.name) as Record<string, Role>;
  }
}

export default class AvalonGame {
  api: AvalonApi;
  lobby: LobbySubscription | null;
  user: UserData | null;
  userPollInterval: ReturnType<typeof setInterval> | null;
  globalStats: Record<string, unknown> | null;
  hostname: string;
  config: GameConfig;
  confirmingEmailError: string | null;
  private _authStateInitialized: boolean;
  private _eventCallback: ((event: string, data?: string) => void) | null;

  constructor(eventCallback: (event: string, data?: string) => void) {
    // XXX TODO: find a better place for this:
    Array.prototype.joinWithAnd = function() {
      if (this.length == 0) return '';
      if (this.length == 1) return this[0];
      const arrCopy = this.slice(0);
      const lastElem = arrCopy.pop();
      return arrCopy.join(', ') + ' and ' + lastElem;
    };

    this.api = new AvalonApi();

    this._authStateInitialized = false;
    this.confirmingEmailError = null;
    this.lobby = null;
    this.user = null;
    this.userPollInterval = null;
    this.globalStats = null;
    this.hostname = window.location.origin + '/';

    _.bindAll(this);

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

  joinLobbyImpl(joinLobbyPromise: Promise<import('axios').AxiosResponse>): Promise<void> {
    return joinLobbyPromise.then(function(this: AvalonGame, resp: import('axios').AxiosResponse) {
      this.subscribeToLobby(resp.data.lobby);
    }.bind(this));
  }

  joinLobby(name: string, lobby: string): Promise<void> {
    return this.joinLobbyImpl(this.api.joinLobby(name, lobby));
  }

  createLobby(name: string): Promise<void> {
    return this.joinLobbyImpl(this.api.createLobby(name));
  }

  leaveLobby(): Promise<void> {
    return this.api.leaveLobby(this.lobby!.name).then(() => this.unsubscribeFromLobby());
  }

  kickPlayer(name: string): Promise<import('axios').AxiosResponse> {
    return this.api.kickPlayer(this.lobby!.name, name);
  }

  cancelGame(): Promise<import('axios').AxiosResponse> {
    return this.api.cancelGame(this.lobby!.name, this.user!.name);
  }

  voteTeam(vote: boolean): Promise<import('axios').AxiosResponse> {
    return this.api.voteTeam(
      this.lobby!.name,
      this.user!.name,
      this.game.currentMissionIdx,
      this.game.currentProposalIdx,
      vote);
  }

  startGame(options: Record<string, unknown>): Promise<import('axios').AxiosResponse> {
    return this.api.startGame(this.lobby!.name, this.config.playerList, this.config.selectedRoleList, options);
  }

  proposeTeam(playerList: string[]): Promise<import('axios').AxiosResponse> {
    return this.api.proposeTeam(
      this.lobby!.name,
      this.user!.name,
      this.game.currentMissionIdx,
      this.game.currentProposalIdx,
      playerList);
  }

  doMission(vote: boolean): Promise<import('axios').AxiosResponse> {
    return this.api.doMission(
      this.lobby!.name,
      this.user!.name,
      this.game.currentMissionIdx,
      this.game.currentProposalIdx,
      vote);
  }

  assassinate(target: string): Promise<import('axios').AxiosResponse> {
    return this.api.assassinate(
      this.lobby!.name,
      this.user!.name,
      target);
  }

  get initialized(): boolean {
    if (!this._authStateInitialized) {
      return false;
    }

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

  get game(): Game {
    return this.lobby!.game;
  }

  userDocUpdated(userData: UserData | null): void {
    this._authStateInitialized = true;

    if (!userData) {
      // User doc doesn't exist yet (server may be offline)
      const token = getToken();
      if (token) {
        const uid = getUserIdFromToken(token);
        if (uid) {
          console.warn('user doc does not exist, using token user');
          this.user = {
            uid,
            name: 'Anonymous',
            email: undefined,
            lobby: null
          };
        }
      }
      return;
    }

    this.user = userData;

    if (!this.user.lobby && (this.lobby != null)) {
      const oldLobby = this.lobby.name;
      this.unsubscribeFromLobby();
      this.notifyEvent('DISCONNECTED_FROM_LOBBY', oldLobby);
    }

    if (this.user.lobby && (this.lobby == null)) {
      this.subscribeToLobby(this.user.lobby);
    }
  }

  unsubscribeFromLobby(): void {
    if (this.lobby != null) {
      this.lobby.stop();
      this.lobby = null;
    }
  }

  subscribeToLobby(lobby: string): void {
    if (this.lobby != null) {
      // want to avoid double-subscriptions (from user doc and create/join func calls)
      return;
    }
    this.lobby = new LobbySubscription(this.user!.uid, lobby, this.config,
      function(this: AvalonGame, evt: string) {
        switch(evt) {
          case 'LOBBY_CONNECTED':
            this.lobbyConnected();
            break;
          case 'GAME_STARTED':
            this.config.updateRoles(this.lobby!.game.roles);
            break;
          case 'PLAYER_LIST_CHANGED':
            this.config.updatePlayerList(this.lobby!.users, true);
            break;
          default:
            console.debug('received', evt, 'in avalon game engine');
        }
        this.notifyEvent(evt);
      }.bind(this)
    );
    this.lobby.start();
  }

  lobbyConnected(): void {
    this.config.updatePlayerList(this.lobby!.users, false);
    if (this.lobby!.game.roles) {
      this.config.updateRoles(this.lobby!.game.roles);
    }
  }

  logout(): void {
    if (this.userPollInterval) {
      clearInterval(this.userPollInterval);
      this.userPollInterval = null;
    }
    this.user = null;
    this._authStateInitialized = true;
    signout();
  }

  async signInAnonymously(): Promise<void> {
    await signupAnonymous();
    await this._onAuthenticated();
  }

  async submitEmailAddr(emailAddr: string, password: string): Promise<void> {
    try {
      // Try signin first
      await signinWithEmail(emailAddr, password);
    } catch {
      // If signin fails, try signup
      await signupWithEmail(emailAddr, password);
    }
    await this._onAuthenticated();
  }

  private async _onAuthenticated(): Promise<void> {
    const token = getToken();
    if (!token) return;

    const uid = getUserIdFromToken(token);
    if (!uid) return;

    console.debug('I am', uid);

    // Call login API (best-effort)
    try {
      await this.api.login('');
    } catch (err) {
      console.warn('API login failed (server may be offline):', (err as Error).message);
    }

    // Start polling for user document updates
    this._startUserPolling(uid);

    // Fetch global stats
    try {
      const result = await db.query<[Record<string, unknown>[]]>(
        `SELECT * FROM stats WHERE id = type::thing('stats', 'global')`
      );
      this.globalStats = result[0]?.[0] ?? null;
    } catch {
      // ignore stats errors
    }
  }

  private _startUserPolling(uid: string): void {
    if (this.userPollInterval) {
      clearInterval(this.userPollInterval);
    }

    const fetchUser = async () => {
      try {
        const result = await db.query<[(UserData & { id?: unknown })[]]>(
          `SELECT * FROM user WHERE id = type::thing('user', $uid)`,
          { uid }
        );
        const raw = result[0]?.[0] ?? null;
        if (raw) {
          // SurrealDB returns 'id' as a RecordId, map it to 'uid' string
          if (!raw.uid && raw.id) {
            const idStr = String(raw.id);
            raw.uid = idStr.includes(':') ? idStr.split(':').slice(1).join(':') : idStr;
          }
        }
        this.userDocUpdated(raw as UserData | null);
      } catch {
        // ignore polling errors
      }
    };

    // Initial fetch
    fetchUser();

    // Poll every 2 seconds
    this.userPollInterval = setInterval(fetchUser, 2000);
  }

  init(): void {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has("purchaseSuccess")) {
      alert('Thank you. Your support means a lot.');
    } else if (urlParams.has('purchaseCanceled')) {
      alert('Maybe next time?');
    }

    // Strip URL params
    if (urlParams.toString()) {
      window.history.replaceState(null, '', window.location.pathname);
    }

    // Try to restore session from localStorage
    connectDb().then(() => {
      return restoreSession();
    }).then((restored) => {
      if (restored) {
        return this._onAuthenticated();
      } else {
        this._authStateInitialized = true;
      }
    }).catch((err) => {
      console.warn('Session restore failed:', err);
      this._authStateInitialized = true;
    });
  }
}
