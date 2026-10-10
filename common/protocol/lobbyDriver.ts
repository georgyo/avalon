/**
 * LobbyDriver (docs/p2p-protocol.md §4, §11.2): subscribes to a lobby code's soul,
 * ingests and verifies envelopes (§3.4), reduces the lobby, publishes this
 * device's lobby messages through the journal (§3.9) and, as admin, runs the
 * automatic roster decisions (§4.3-4.5). DOM-free: used by
 * client/src/p2p/lobbyClient.ts and by node simulations.
 *
 * Additions to the §11.2 constructor: an optional `now()` for envelope `t`
 * (protocol code has no clock, §11.1; the client passes its drift-corrected
 * clock, default 0), `openAdmission` (tests: admit every valid join without a
 * ticket) and `keyComplete` (reclaim and takeover checks, §4.5). Additional
 * helpers: `state`, `ready()`, `messages()`, `candidates()`, `ingest()`,
 * `inviteKey()`, `approve()`, `decline()`, `awaitingApproval()`,
 * `rerunAutomation()`. Publishing does not wait for the relay echo.
 */
import { b64uEncode, randomBytes } from '../crypto/bytes.ts';
import type { B64, Hex32, Pub } from '../crypto/types.ts';
import { decodeCached } from './driver.ts';
import { decodeEnvelope, encodeEnvelope, lobbySoul, soulOf, type Signer } from './envelope.ts';
import {
  adminNextAction, awaitingApproval, candidates as lobbyCandidates, inviteKeyOf, inviteTicket, memberOf, reduceLobby,
  rejectionMessage, type LobbyCandidate, type LobbyState,
} from './lobby.ts';
import { MAX_PLAYERS, MIN_PLAYERS, RULES_HASH, validateName, validateSelectedRoles } from './rules.ts';
import type { Bodies, Envelope, GameConfig, Journal, LobbyMsgType, StoredMsg, Transport } from './types.ts';

interface Waiter {
  joinId: Hex32;
  resolve: () => void;
  reject: (e: Error) => void;
}

export interface LobbyDriverOptions {
  code: string;
  lobbyId: Hex32 | null;
  signer: Signer;
  transport: Transport;
  journal: Journal;
  onState(s: LobbyState): void;
  now?: () => number;
  /** Admit every valid join automatically, ticket or not (tests and simulations; default false, §4.3). */
  openAdmission?: boolean;
  /** Whether step `key` of a config completed on this device (§4.5 reclaim). */
  keyComplete?: (configId: Hex32) => boolean;
}

export class LobbyDriver {
  readonly code: string;
  private lobbyIdValue: Hex32 | null;
  private readonly signer: Signer;
  private readonly transport: Transport;
  private readonly journal: Journal;
  private readonly onStateCb: (s: LobbyState) => void;
  private readonly now: () => number;
  private readonly soul: string;
  private readonly msgs = new Map<Hex32, StoredMsg>();
  /** GUN keys of the accepted messages. */
  private readonly keys = new Set<Hex32>();
  private unsub: (() => void) | null = null;
  private current: LobbyState | null = null;
  private gameActive = false;
  private evalScheduled = false;
  private automationBusy = false;
  private automationAgain = false;
  private waiters: Waiter[] = [];
  private readyWaiters: { resolve: (s: LobbyState) => void; reject: (e: Error) => void }[] = [];
  private lastT = 0;
  private readonly openAdmission: boolean;
  private readonly keyComplete: (configId: Hex32) => boolean;
  private inviteKeyBytes: Uint8Array | null = null;
  private readonly approved = new Set<Hex32>();
  private readonly declined = new Set<Hex32>();

  constructor(o: LobbyDriverOptions) {
    this.code = o.code;
    this.soul = lobbySoul(o.code);
    this.lobbyIdValue = o.lobbyId;
    this.signer = o.signer;
    this.transport = o.transport;
    this.journal = o.journal;
    this.onStateCb = o.onState;
    this.now = o.now ?? (() => 0);
    this.openAdmission = o.openAdmission === true;
    this.keyComplete = o.keyComplete ?? ((): boolean => false);
  }

  get lobbyId(): Hex32 | null {
    return this.lobbyIdValue;
  }

  /** The latest reduced state (null until the lobby's create message is known). */
  get state(): LobbyState | null {
    return this.current;
  }

  /** Every verified message of this code's soul, in ingestion order. */
  messages(): StoredMsg[] {
    return [...this.msgs.values()];
  }

  /** Whether a value with this GUN key was ingested (verified and kept). */
  accepted(key: string): boolean {
    return this.keys.has(key);
  }

  /** The lobbies currently using this code (§4.3). */
  candidates(): LobbyCandidate[] {
    return lobbyCandidates(this.code, this.msgs.values());
  }

  start(): void {
    if (this.unsub !== null) return;
    this.unsub = this.transport.subscribe(this.soul, (key, value) => this.ingest(this.soul, key, value));
    if (this.lobbyIdValue !== null) void this.republish(this.lobbyIdValue);
    this.scheduleEval();
  }

  stop(): void {
    if (this.unsub !== null) this.unsub();
    this.unsub = null;
    for (const w of this.waiters) w.reject(new Error('Stopped'));
    this.waiters = [];
    for (const r of this.readyWaiters) r.reject(new Error('Stopped'));
    this.readyWaiters = [];
  }

  /** Resolves with the state once this lobby's create message has been received (start() first). */
  ready(): Promise<LobbyState> {
    const s = this.evaluateNow();
    if (s !== null) return Promise.resolve(s);
    if (this.unsub === null) return Promise.reject(new Error('Not started'));
    return new Promise((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
  }

  /** Ingestion pipeline (§3.4): returns true if the message was new and valid. */
  ingest(soul: string, key: string, value: string): boolean {
    if (soul !== this.soul) return false;
    // Before the signature check: only this code's creates and, once the lobby is known, its own messages.
    const lobbyId = this.lobbyIdValue;
    const d = decodeCached(value, key, (env) => (env.type === 'lobby.create'
      ? (env.body as Bodies['lobby.create']).code === this.code
      : lobbyId === null || env.lobby === lobbyId));
    if ('error' in d) return false;
    let expected: string;
    try {
      expected = soulOf(d.env, this.code);
    } catch {
      return false;
    }
    if (expected !== soul) return false;
    if (d.env.type === 'lobby.create' && (d.env.body as Bodies['lobby.create']).code !== this.code) return false;
    if (this.msgs.has(d.msgId)) return false;
    this.msgs.set(d.msgId, d);
    this.keys.add(d.key);
    this.scheduleEval();
    return true;
  }

  setGameActive(active: boolean): void {
    if (this.gameActive === active) return;
    this.gameActive = active;
    this.scheduleEval();
  }

  // ------------------------------------------------------------ user actions

  async create(name: string): Promise<Hex32> {
    if (this.lobbyIdValue !== null) throw new Error('Already in a lobby');
    if (validateName(name) !== null) throw new Error('Invalid name');
    const env = this.envelope('lobby.create', '', '', { code: this.code, name, nonce: b64uEncode(randomBytes(16)) });
    const enc = encodeEnvelope(env, this.signer);
    const lobbyId = enc.msgId;
    await this.journal.put(lobbyId, 'create', enc.value);
    this.lobbyIdValue = lobbyId;
    this.ingest(this.soul, enc.key, enc.value);
    this.send(enc.key, enc.value);
    await this.publishRoster(lobbyId, lobbyId, {
      seq: 1, admin: this.signer.pub, members: [{ pub: this.signer.pub, name, joinId: lobbyId }], rejected: [], closed: false,
    });
    return lobbyId;
  }

  /** This admin's invite key (§4.3), for the invite link; null before the lobby is known. */
  inviteKey(): B64 | null {
    const key = this.inviteKeyRaw();
    return key === null ? null : b64uEncode(key);
  }

  private inviteKeyRaw(): Uint8Array | null {
    const lobbyId = this.lobbyIdValue;
    if (lobbyId === null) return null;
    this.inviteKeyBytes ??= inviteKeyOf(this.signer, lobbyId);
    return this.inviteKeyBytes;
  }

  /** Join requests that wait for this admin's approval (§4.3); empty unless this device is the admin. */
  awaitingApproval(): { joinId: Hex32; pub: Pub; name: string }[] {
    const s = this.current;
    const key = this.inviteKeyRaw();
    if (s === null || key === null || s.head.admin !== this.signer.pub || this.openAdmission) return [];
    return awaitingApproval(s, key).filter((j) => !this.approved.has(j.joinId) && !this.declined.has(j.joinId));
  }

  /** The admin admits a join request without a ticket (§4.3); the next automatic roster lists it. */
  approve(joinId: Hex32): void {
    this.requireAdmin();
    this.approved.add(joinId);
    this.declined.delete(joinId);
    this.scheduleEval();
  }

  /** The admin declines a join request (reason 'declined'). */
  decline(joinId: Hex32): void {
    this.requireAdmin();
    this.declined.add(joinId);
    this.approved.delete(joinId);
    this.scheduleEval();
  }

  /** Re-runs the admin automation (e.g. after a game's key step completed: §4.5 reclaim). */
  rerunAutomation(): void {
    if (this.unsub !== null && this.current !== null) void this.runAutomation();
  }

  /**
   * Resolves when a roster on the head chain admits this join; rejects with Error(reason).
   * `inviteKey`: the key of the invite link; the join then carries a ticket and is admitted
   * automatically, otherwise it waits for the admin's approval (§4.3).
   */
  async join(name: string, inviteKey?: Uint8Array): Promise<void> {
    const lobbyId = this.requireLobby();
    if (validateName(name) !== null) throw new Error('Invalid name');
    const s = await this.ready();
    if (s.head.closed) throw new Error(`Lobby ${this.code} is closed`);
    const me = memberOf(s, this.signer.pub);
    if (me !== undefined && !s.leaves.has(this.signer.pub)) return;
    const ticket = inviteKey === undefined ? null : inviteTicket(inviteKey, lobbyId, this.signer.pub);
    let joinId: Hex32 | null = null;
    for (const [id, j] of s.joins) {
      if (j.pub === this.signer.pub && j.name === name && j.status === 'pending' && (ticket === null || j.ticket === ticket)) joinId = id;
    }
    if (joinId === null) {
      const t = Math.max(this.nextT(), this.lastOwnJoinT(s) + 1);
      const env = this.envelope('lobby.join', lobbyId, '', ticket === null ? { name } : { name, ticket }, t);
      const enc = encodeEnvelope(env, this.signer);
      joinId = enc.msgId;
      await this.journal.put(lobbyId, 'join/' + joinId, enc.value);
      this.ingest(this.soul, enc.key, enc.value);
      this.send(enc.key, enc.value);
    }
    const id = joinId;
    await new Promise<void>((resolve, reject) => {
      this.waiters.push({ joinId: id, resolve, reject });
      this.scheduleEval();
    });
  }

  /**
   * Leaves the lobby (§4.5). The admin first hands off to the first other member
   * (or closes the lobby when alone). A pending join request is withdrawn.
   * Canceling a running game first is the caller's job (it needs the game state).
   */
  async leave(): Promise<void> {
    const lobbyId = this.requireLobby();
    const s = this.evaluateNow();
    if (s === null) return;
    const me = memberOf(s, this.signer.pub);
    if (me !== undefined && s.head.admin === this.signer.pub && !s.head.closed) {
      const others = s.head.members.filter((m) => m.pub !== this.signer.pub);
      await this.publishRoster(lobbyId, s.head.rosterId, others.length === 0
        ? { seq: s.head.seq + 1, admin: this.signer.pub, members: [], rejected: [], closed: true }
        : { seq: s.head.seq + 1, admin: others[0].pub, members: others, rejected: [], closed: false });
    }
    const ends: Hex32[] = [];
    if (me !== undefined) ends.push(me.joinId);
    for (const [id, j] of s.joins) if (j.pub === this.signer.pub && j.status === 'pending') ends.push(id);
    for (const joinId of ends) {
      await this.publish(lobbyId, 'leave/' + joinId, this.envelope('lobby.leave', lobbyId, joinId, {}));
    }
    for (const w of this.waiters) w.reject(new Error('Left the lobby'));
    this.waiters = [];
  }

  async kick(pub: Pub): Promise<void> {
    const lobbyId = this.requireLobby();
    const s = this.requireAdmin();
    if (this.gameActive) throw new Error('Cancel game first');
    if (pub === this.signer.pub) throw new Error("Can't kick yourself");
    if (memberOf(s, pub) === undefined) throw new Error('No such user');
    await this.publishRoster(lobbyId, s.head.rosterId, {
      seq: s.head.seq + 1, admin: this.signer.pub, members: s.head.members.filter((m) => m.pub !== pub), rejected: [], closed: false,
    });
  }

  /** Publishes a takeover roster (§4.5); the UI offers it only when the admin is gone. */
  async takeOver(): Promise<void> {
    const lobbyId = this.requireLobby();
    const s = this.evaluateNow();
    if (s === null || s.head.closed) throw new Error('Lobby closed');
    if (memberOf(s, this.signer.pub) === undefined) throw new Error('You are not in that lobby');
    if (s.head.admin === this.signer.pub) return;
    await this.publishRoster(lobbyId, s.head.rosterId, {
      seq: s.head.seq + 1, admin: this.signer.pub, members: s.head.members.map((m) => ({ ...m })), rejected: [], closed: false,
    });
  }

  /** Publishes `lobby.config` (§4.6.1) and returns its configId. */
  async startGame(seats: { pub: Pub; name: string }[], selectedRoles: string[], options: { inGameLog: boolean }): Promise<Hex32> {
    const lobbyId = this.requireLobby();
    const s = this.requireAdmin();
    if (this.gameActive) throw new Error('Game already in progress');
    if (seats.length < MIN_PLAYERS || seats.length > MAX_PLAYERS) throw new Error(`Bad number of players: ${seats.length}`);
    const members = s.head.members;
    const sameSet = seats.length === members.length && new Set(seats.map((x) => x.pub)).size === seats.length
      && members.every((m) => seats.some((x) => x.pub === m.pub && x.name === m.name));
    if (!sameSet) throw new Error('Player list does not match the lobby');
    if (!validateSelectedRoles(selectedRoles)) throw new Error('Bad roles ' + selectedRoles.join(', '));
    const config: GameConfig = {
      gameId: b64uEncode(randomBytes(16)),
      seats: seats.map((x) => ({ pub: x.pub, name: x.name })),
      selectedRoles: [...selectedRoles],
      options: { inGameLog: options.inGameLog },
      rulesHash: RULES_HASH,
    };
    // A config based on a roster another config already used could lose the §4.6.4 tie-break (lowest
    // msgId) to the old, terminal game: base the new one on a fresh no-op roster, so it is the only
    // config at the highest roster seq.
    let base = s.head.rosterId;
    if ([...s.configs.values()].some((c) => c.rosterId === base)) {
      base = await this.publishRoster(lobbyId, base, {
        seq: s.head.seq + 1, admin: this.signer.pub, members: s.head.members.map((m) => ({ ...m })), rejected: [], closed: false,
      });
    }
    const env = this.envelope('lobby.config', lobbyId, base, config);
    const msgId = await this.publish(lobbyId, 'config/' + config.gameId, env);
    this.gameActive = true;
    return msgId;
  }

  // ------------------------------------------------------------ internals

  private requireLobby(): Hex32 {
    if (this.lobbyIdValue === null) throw new Error('Not in a lobby');
    return this.lobbyIdValue;
  }

  private requireAdmin(): LobbyState {
    const s = this.evaluateNow();
    if (s === null || s.head.closed) throw new Error('Lobby closed');
    if (s.head.admin !== this.signer.pub) throw new Error('Not lobby admin');
    return s;
  }

  private nextT(): number {
    const t = Math.max(0, this.now());
    this.lastT = Math.max(this.lastT, t);
    return this.lastT;
  }

  private lastOwnJoinT(s: LobbyState): number {
    let t = -1;
    for (const id of s.joins.keys()) {
      const m = this.msgs.get(id);
      if (m !== undefined && m.env.author === this.signer.pub) t = Math.max(t, m.env.t);
    }
    return t;
  }

  private envelope<T extends LobbyMsgType>(type: T, lobby: Hex32 | '', prev: Hex32 | '', body: Bodies[T], t?: number): Envelope<T> {
    return { v: 1, type, lobby, game: '', step: '', author: this.signer.pub, prev, t: t ?? this.nextT(), body };
  }

  /** publish(slot, build) of §3.9: re-put the journaled value if the slot exists, else sign, journal, put. */
  private async publish(scope: Hex32, slot: string, env: Envelope): Promise<Hex32> {
    const existing = await this.journal.get(scope, slot);
    let value: string;
    let key: Hex32;
    let msgId: Hex32;
    if (existing !== null) {
      const d = decodeEnvelope(existing);
      if ('error' in d) throw new Error('corrupt journal entry ' + slot + ': ' + d.error);
      ({ value, key, msgId } = d);
    } else {
      const enc = encodeEnvelope(env, this.signer);
      // Atomic: a concurrent publish of the slot (another driver of this device) keeps the first value.
      const stored = await this.journal.putIfAbsent(scope, slot, enc.value);
      if (stored === enc.value) ({ value, key, msgId } = enc);
      else {
        const d = decodeEnvelope(stored);
        if ('error' in d) throw new Error('corrupt journal entry ' + slot + ': ' + d.error);
        ({ value, key, msgId } = d);
      }
    }
    this.ingest(this.soul, key, value);
    this.send(key, value);
    return msgId;
  }

  /**
   * Hands a journaled value to the transport without waiting for the relay echo:
   * the state updates from the local ingest, and the journal is re-put on restart
   * (and by the client's watchdog), so an offline device never blocks here.
   */
  private send(key: Hex32, value: string): void {
    this.transport.publish(this.soul, key, value).catch(() => undefined);
  }

  private publishRoster(scope: Hex32, prev: Hex32, body: Bodies['lobby.roster']): Promise<Hex32> {
    return this.publish(scope, `roster/${body.seq}/${prev}`, this.envelope('lobby.roster', scope, prev, body));
  }

  private async republish(scope: Hex32): Promise<void> {
    const values = await this.journal.all(scope);
    for (const value of values) {
      const d = decodeEnvelope(value);
      if ('error' in d) continue;
      this.ingest(this.soul, d.key, d.value);
      this.send(d.key, d.value);
    }
  }

  private evaluateNow(): LobbyState | null {
    const lobbyId = this.lobbyIdValue;
    if (lobbyId === null || !this.msgs.has(lobbyId)) return null;
    this.current = reduceLobby(lobbyId, this.msgs.values());
    return this.current;
  }

  private scheduleEval(): void {
    if (this.evalScheduled) return;
    this.evalScheduled = true;
    queueMicrotask(() => {
      this.evalScheduled = false;
      const s = this.evaluateNow();
      if (s === null) return;
      for (const r of this.readyWaiters) r.resolve(s);
      this.readyWaiters = [];
      this.settleWaiters(s);
      this.onStateCb(s);
      if (this.unsub !== null) void this.runAutomation();
    });
  }

  private settleWaiters(s: LobbyState): void {
    const keep: Waiter[] = [];
    for (const w of this.waiters) {
      const j = s.joins.get(w.joinId);
      const m = memberOf(s, this.signer.pub);
      if ((j !== undefined && j.status === 'admitted') || (m !== undefined && m.joinId === w.joinId)) w.resolve();
      else if (j !== undefined && j.status === 'rejected') w.reject(new Error(rejectionMessage(j.reason ?? 'rejected')));
      else if (s.head.closed) w.reject(new Error(`Lobby ${this.code} is closed`));
      else keep.push(w);
    }
    this.waiters = keep;
  }

  /** Admin automation; one roster at a time, re-run until there is nothing to do. */
  private async runAutomation(): Promise<void> {
    if (this.automationBusy) {
      this.automationAgain = true;
      return;
    }
    this.automationBusy = true;
    try {
      this.automationAgain = true;
      while (this.automationAgain) {
        this.automationAgain = false;
        const s = this.evaluateNow();
        const lobbyId = this.lobbyIdValue;
        if (s === null || lobbyId === null || this.unsub === null) break;
        const inviteKey = this.openAdmission ? undefined : this.inviteKeyRaw() ?? undefined;
        const action = adminNextAction(s, this.signer.pub, this.gameActive, {
          inviteKey, approved: this.approved, declined: this.declined, keyComplete: this.keyComplete,
        });
        if (action.kind === 'none') continue;
        await this.publishRoster(lobbyId, action.prev ?? s.head.rosterId, action.body);
        const after = this.evaluateNow();
        // Continue only if our roster became the head; otherwise wait for new input.
        if (after !== null && after.head.rosterId !== s.head.rosterId) this.automationAgain = true;
      }
    } catch {
      // Publishing failed (journal or transport); the next ingested message retries.
    } finally {
      this.automationBusy = false;
    }
  }
}
