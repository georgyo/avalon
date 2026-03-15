import { Surreal, RecordId, Table, jsonify } from 'surrealdb';
import { markRaw } from 'vue';
import { bindAll, difference, keys, keyBy, values } from 'lodash-es';
import * as avalonLib from '@avalon/common/avalonlib';
import { AvalonApi } from './avalon-api-surreal';
import surrealConfig from './surreal-config';
import type { Role, GameData, Mission, Proposal, LobbyData, LobbyUser, UserData, RoleDoc, PlayerRoleData } from './types';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Array<T> {
    joinWithAnd(): string;
  }
}

const TOKEN_KEY = 'avalon_surreal_token';

// Extract the raw ID portion from a RecordId (e.g. RecordId('lobby','ABC') -> 'ABC')
function recordIdRaw(rid: RecordId | string | null | undefined): string {
  if (rid == null) return '';
  if (typeof rid === 'string') {
    // Handle "table:id" format strings
    const parts = rid.split(':');
    return parts.length > 1 ? parts.slice(1).join(':') : rid;
  }
  return String(rid.id ?? rid);
}

function recordIdsEqual(a: RecordId | string | null | undefined, b: RecordId | string | null | undefined): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  // Compare the raw ID portions
  return recordIdRaw(a) === recordIdRaw(b);
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
  private _db: Surreal;
  private _doc: LobbyData | null;
  private _roleDoc: RoleDoc | null;
  private _game: Game | null;
  private _config: GameConfig;
  private _eventHandler: (evt: string) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _liveQueries: { lobby?: any; role?: any };
  private _pollInterval: ReturnType<typeof setInterval> | null;

  constructor(uid: string, lobbyName: string, db: Surreal, config: GameConfig, eventHandler: (evt: string) => void) {
    this.name = lobbyName;
    this._uid = uid;
    this._db = db;
    this._doc = null;
    this._roleDoc = null;
    this._game = null;
    this._config = config;
    this.connected = false;
    this._eventHandler = eventHandler;
    this._liveQueries = {};
    this._pollInterval = null;
  }

  get data(): LobbyData {
    return this._doc!;
  }

  get users(): Record<string, LobbyUser> {
    return this.data.users;
  }

  get admin(): { uid: string | RecordId; name: string } {
    return this.data.admin;
  }

  get game(): Game {
    return this._game!;
  }

  get role(): RoleDoc | null {
    return this._roleDoc;
  }

  async start(): Promise<void> {
    const lobbyId = new RecordId('lobby', this.name);

    // Initial fetch of lobby data
    try {
      const lobbyData = await this._db.select<LobbyData>(lobbyId);
      if (lobbyData) {
        this._lobbyDocUpdated(jsonify(lobbyData) as LobbyData);
      }
    } catch (err) {
      console.warn('Failed to fetch lobby data:', err);
    }

    // Live query on lobby table
    const lobbyLive = await this._db.live(new Table('lobby'));
    lobbyLive.subscribe((action: string, result: LobbyData) => {
      if (action === 'CLOSE') return;
      const plain = jsonify(result) as LobbyData & { id?: string };
      if (plain?.id && recordIdRaw(plain.id) === this.name) {
        if (action === 'DELETE') {
          console.error('lobby', this.name, 'was deleted');
          this.stop();
          return;
        }
        this._lobbyDocUpdated(plain);
      }
    });
    this._liveQueries.lobby = markRaw(lobbyLive);

    // Live query on player_role table (permissions filter to own records)
    const roleLive = await this._db.live(new Table('player_role'));
    roleLive.subscribe((action: string, result: PlayerRoleData) => {
      if (action === 'CLOSE') return;
      if (action === 'DELETE') {
        this._roleDoc = null;
        return;
      }
      const plain = jsonify(result) as PlayerRoleData;
      if (plain && recordIdRaw(plain.lobby) === this.name) {
        this._roleDocUpdated(plain);
      }
    });
    this._liveQueries.role = markRaw(roleLive);

    // Initial fetch of role data
    try {
      const roleResults = await this._db.query<[PlayerRoleData[]]>(
        'SELECT * FROM player_role WHERE lobby = $lobby LIMIT 1',
        { lobby: lobbyId }
      );
      if (roleResults[0] && roleResults[0].length > 0) {
        this._roleDocUpdated(jsonify(roleResults[0][0]) as PlayerRoleData);
      }
    } catch {
      // No role yet, that's fine
    }

    // Poll for updates as a fallback in case live queries don't fire
    this._pollInterval = setInterval(async () => {
      if (!this.connected) return;
      try {
        const lobbyData = await this._db.select<LobbyData>(lobbyId);
        if (lobbyData) {
          this._lobbyDocUpdated(jsonify(lobbyData) as LobbyData);
        }
        // Also check for role updates
        const roleResults = await this._db.query<[PlayerRoleData[]]>(
          'SELECT * FROM player_role WHERE lobby = $lobby LIMIT 1',
          { lobby: lobbyId }
        );
        if (roleResults[0] && roleResults[0].length > 0) {
          this._roleDocUpdated(jsonify(roleResults[0][0]) as PlayerRoleData);
        } else if (this._roleDoc != null) {
          // Role was deleted (game ended)
          this._roleDoc = null;
        }
      } catch {
        // ignore polling errors
      }
    }, 2000);
  }

  async stop(): Promise<void> {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
    if (this._liveQueries.lobby) {
      try { await this._liveQueries.lobby.kill(); } catch { /* ignore */ }
    }
    if (this._liveQueries.role) {
      try { await this._liveQueries.role.kill(); } catch { /* ignore */ }
    }
    this._liveQueries = {};
    this.connected = false;
  }

  private _roleDocUpdated(data: PlayerRoleData): void {
    if (data) {
      this._roleDoc = {
        role: this._config.roleMap[data.role],
        sees: data.sees,
      };
    } else {
      this._roleDoc = null;
    }
  }

  private _lobbyDocUpdated(newData: LobbyData): void {
    const oldDoc = this._doc;

    this._doc = newData;
    this._game = new Game(this._doc.game, this._config);

    if (oldDoc == null) {
      this.connected = true;
      this._eventHandler('LOBBY_CONNECTED');
      return;
    }

    if (!recordIdsEqual(oldDoc.admin.uid, this._doc.admin.uid)) {
      this._eventHandler('LOBBY_NEW_ADMIN');
    }

    if ((keys(oldDoc.users).length != keys(this._doc.users).length) ||
        !keys(oldDoc.users).every(u => this._doc!.users[u])) {
      this._eventHandler('PLAYER_LIST_CHANGED');
    }

    if (oldDoc.game.state != this._doc.game.state) {
      this._eventHandler(
        this._doc.game.state == 'ACTIVE' ? 'GAME_STARTED' : 'GAME_ENDED'
      );
    } else if (oldDoc.game.phase != this._doc.game.phase) {
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
    roles.forEach(r => this.roleMap[r].selected = true);
  }

  setupRoles(): void {
    this.roles = avalonLib.ROLES;
    this.selectableRoles = this.roles.filter(r => r.selectable);
    this.roleMap = keyBy(this.roles, r => r.name) as Record<string, Role>;
  }
}

export default class AvalonGame {
  db: Surreal;
  api: AvalonApi;
  lobby: LobbySubscription | null;
  user: UserData | null;
  globalStats: Record<string, unknown> | null;
  config: GameConfig;
  private _authStateInitialized: boolean;
  private _eventCallback: ((event: string, data?: string) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _userLiveQuery: any | null;

  constructor(eventCallback: (event: string, data?: string) => void) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Array.prototype.joinWithAnd = function(this: any[]) {
      if (this.length == 0) return '';
      if (this.length == 1) return this[0];
      const arrCopy = this.slice(0);
      const lastElem = arrCopy.pop();
      return arrCopy.join(', ') + ' and ' + lastElem;
    };

    // markRaw prevents Vue from wrapping the Surreal instance in a Proxy,
    // which would break access to private class fields (#connection).
    this.db = markRaw(new Surreal());
    this.api = new AvalonApi(this.db);

    this._authStateInitialized = false;
    this.lobby = null;
    this.user = null;
    this.globalStats = null;
    this._userLiveQuery = null;

    bindAll(this);

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

  async joinLobby(name: string, lobby: string): Promise<void> {
    const resp = await this.api.joinLobby(name, lobby);
    // Update local user state immediately (don't wait for live query)
    const lobbyCode = resp.lobby as string;
    if (this.user) {
      this.user.name = resp.name as string;
      (this.user as Record<string, unknown>).lobby = lobbyCode;
    }
    await this.subscribeToLobby(lobbyCode);
  }

  async createLobby(name: string): Promise<void> {
    try {
      const resp = await this.api.createLobby(name);
      // Update local user state immediately (don't wait for live query)
      const lobbyCode = resp.lobby as string;
      if (this.user) {
        this.user.name = resp.name as string;
        (this.user as Record<string, unknown>).lobby = lobbyCode;
      }
      await this.subscribeToLobby(lobbyCode);
    } catch (err) {
      // Retry on lobby code collision
      if (err instanceof Error && err.message === 'LOBBY_CODE_COLLISION') {
        return this.createLobby(name);
      }
      throw err;
    }
  }

  async leaveLobby(): Promise<void> {
    await this.api.leaveLobby(this.lobby!.name);
    this.unsubscribeFromLobby();
    // Clear local user lobby state immediately
    if (this.user) {
      (this.user as Record<string, unknown>).lobby = null;
    }
  }

  kickPlayer(name: string): Promise<Record<string, unknown>> {
    return this.api.kickPlayer(this.lobby!.name, name);
  }

  cancelGame(): Promise<Record<string, unknown>> {
    return this.api.cancelGame(this.lobby!.name, this.user!.name);
  }

  voteTeam(vote: boolean): Promise<Record<string, unknown>> {
    return this.api.voteTeam(
      this.lobby!.name,
      this.user!.name,
      this.game.currentMissionIdx,
      this.game.currentProposalIdx,
      vote);
  }

  startGame(options: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.api.startGame(this.lobby!.name, this.config.playerList, this.config.selectedRoleList, options);
  }

  proposeTeam(playerList: string[]): Promise<Record<string, unknown>> {
    return this.api.proposeTeam(
      this.lobby!.name,
      this.user!.name,
      this.game.currentMissionIdx,
      this.game.currentProposalIdx,
      playerList);
  }

  doMission(vote: boolean): Promise<Record<string, unknown>> {
    return this.api.doMission(
      this.lobby!.name,
      this.user!.name,
      this.game.currentMissionIdx,
      this.game.currentProposalIdx,
      vote);
  }

  assassinate(target: string): Promise<Record<string, unknown>> {
    return this.api.assassinate(
      this.lobby!.name,
      this.user!.name,
      target);
  }

  get initialized(): boolean {
    if (!this._authStateInitialized) {
      return false;
    }
    return (this.user == null) || !this.user.lobby || this.isInLobby;
  }

  get isLoggedIn(): boolean {
    return (this.initialized && (this.user != null));
  }

  get isAdmin(): boolean {
    return this.isInLobby && recordIdsEqual(this.lobby!.admin.uid, this.user!.uid);
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

  private async userDocUpdated(userData: UserData): Promise<void> {
    this._authStateInitialized = true;

    const oldLobby = this.user?.lobby;
    this.user = userData;
    // Store the record ID string as uid for compatibility
    if (userData.id) {
      this.user.uid = String(userData.id);
    }

    if (!this.user.lobby && (this.lobby != null)) {
      const oldLobbyName = this.lobby.name;
      this.unsubscribeFromLobby();
      this.notifyEvent('DISCONNECTED_FROM_LOBBY', oldLobbyName);
    }

    if (this.user.lobby && (this.lobby == null)) {
      await this.subscribeToLobby(recordIdRaw(this.user.lobby));
    }
  }

  unsubscribeFromLobby(): void {
    if (this.lobby != null) {
      this.lobby.stop();
      this.lobby = null;
    }
  }

  async subscribeToLobby(lobbyCode: string): Promise<void> {
    if (this.lobby != null) {
      return;
    }
    this.lobby = new LobbySubscription(
      this.user!.uid,
      lobbyCode,
      this.db,
      this.config,
      ((evt: string) => {
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
      })
    );
    await this.lobby.start();
  }

  lobbyConnected(): void {
    this.config.updatePlayerList(this.lobby!.users, false);
    if (this.lobby!.game.roles) {
      this.config.updateRoles(this.lobby!.game.roles);
    }
  }

  async logout(): Promise<void> {
    // Kill user live query before invalidating
    if (this._userLiveQuery) {
      try { await this._userLiveQuery.kill(); } catch { /* ignore */ }
      this._userLiveQuery = null;
    }
    this.unsubscribeFromLobby();
    await this.db.invalidate();
    localStorage.removeItem(TOKEN_KEY);
    this.user = null;
    this._authStateInitialized = true;
  }

  async signInAnonymously(): Promise<void> {
    const tokens = await this.db.signup({
      namespace: surrealConfig.namespace,
      database: surrealConfig.database,
      access: surrealConfig.access,
      variables: {},
    });

    // Store token for reconnection
    if (tokens?.access) {
      localStorage.setItem(TOKEN_KEY, tokens.access);
    }

    // Login API call (best-effort)
    try {
      await this.api.login();
    } catch (err) {
      console.warn('API login failed:', err);
    }

    // Set up user data listening
    await this._setupUserListener();
  }

  private async _setupUserListener(): Promise<void> {
    // Get current user data
    try {
      const results = await this.db.query<[UserData[]]>('SELECT * FROM user WHERE id = $auth.id');
      if (results[0] && results[0].length > 0) {
        this.userDocUpdated(jsonify(results[0][0]) as UserData);
      } else {
        this._authStateInitialized = true;
      }
    } catch (err) {
      console.warn('Failed to fetch user data:', err);
      this._authStateInitialized = true;
    }

    // Live query on user table (permissions filter to own record)
    try {
      const userLive = await this.db.live(new Table('user'));
      userLive.subscribe((action: string, result: UserData) => {
        if (action === 'CLOSE') return;
        if (action === 'DELETE') {
          this.user = null;
          this._authStateInitialized = true;
          return;
        }
        this.userDocUpdated(jsonify(result) as UserData);
      });
      this._userLiveQuery = markRaw(userLive);
    } catch (err) {
      console.warn('Failed to set up user live query:', err);
    }

    // Fetch global stats
    try {
      const statsResults = await this.db.query<[Record<string, unknown>[]]>(
        'SELECT * FROM global_stats:global'
      );
      if (statsResults[0] && statsResults[0].length > 0) {
        this.globalStats = jsonify(statsResults[0][0]) as Record<string, unknown>;
      }
    } catch {
      // Stats not available, that's ok
    }
  }

  async init(): Promise<void> {
    try {
      // Connect to SurrealDB
      console.debug('Connecting to SurrealDB at', surrealConfig.url);
      await this.db.connect(surrealConfig.url, {
        namespace: surrealConfig.namespace,
        database: surrealConfig.database,
      });
      console.debug('Connected to SurrealDB');

      // Try to restore session from stored token
      const storedToken = localStorage.getItem(TOKEN_KEY);
      if (storedToken) {
        try {
          await this.db.authenticate(storedToken);
          console.debug('Restored session from stored token');

          // Login API call (best-effort)
          try {
            await this.api.login();
          } catch (err) {
            console.warn('API login failed:', err);
          }

          await this._setupUserListener();
          return;
        } catch (err) {
          console.warn('Stored token invalid, clearing:', err);
          localStorage.removeItem(TOKEN_KEY);
        }
      }

      // No valid stored token - user needs to sign up
      this._authStateInitialized = true;
    } catch (err) {
      console.error('Failed to connect to SurrealDB:', err);
      this._authStateInitialized = true;
    }
  }
}
