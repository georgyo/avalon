/**
 * Protocol types (docs/p2p-protocol.md §3.2, §6, §11.2). Normative: the envelope
 * shapes are fixed by the specification. The encoded primitive types live in
 * common/crypto/types.ts (WP-A) and are re-exported here.
 */
import type { B64, CardLabel, CtE, Hex32, Pt, Pub, Sc, SigmaProofE } from '../crypto/types.ts';
import type { GameOutcome, Mission } from './views.ts';

export type { B64, CardLabel, CtE, Hex32, Pt, Pub, Sc, SigmaProofE };

export type LobbyMsgType = 'lobby.create' | 'lobby.join' | 'lobby.leave' | 'lobby.roster' | 'lobby.config';
export type GameMsgType =
  | 'key' | 'shuffle' | 'deal' | 'ot.recv' | 'ot.send'
  | 'propose' | 'vote.commit' | 'vote.reveal' | 'ballot' | 'tally' | 'assassinate'
  | 'cancel' | 'reveal';
export type MsgType = LobbyMsgType | GameMsgType | 'log';

export const LOBBY_MSG_TYPES: readonly LobbyMsgType[] = ['lobby.create', 'lobby.join', 'lobby.leave', 'lobby.roster', 'lobby.config'];
/** Game messages stored in the `setup#` soul (§3.1). */
export const SETUP_MSG_TYPES: readonly GameMsgType[] = ['key', 'shuffle', 'deal', 'ot.recv', 'ot.send'];
/** Game messages stored in the `play#` soul (§3.1). */
export const PLAY_MSG_TYPES: readonly GameMsgType[] = [
  'propose', 'vote.commit', 'vote.reveal', 'ballot', 'tally', 'assassinate', 'cancel', 'reveal',
];
export const MSG_TYPES: readonly MsgType[] = [...LOBBY_MSG_TYPES, ...SETUP_MSG_TYPES, ...PLAY_MSG_TYPES, 'log'];

export interface Member { pub: Pub; name: string; joinId: Hex32 }

export interface GameConfig {
  gameId: B64;                               // 16 random bytes
  seats: { pub: Pub; name: string }[];      // seat order = playerList order chosen by the admin
  selectedRoles: string[];                  // subset of selectable role names, ROLES order, unique
  options: { inGameLog: boolean };
  rulesHash: Hex32;                         // rules.ts RULES_HASH
}

export type RejectReason = 'name-taken' | 'invalid-name' | 'full' | 'game-active';
export type CancelReason = 'cancel' | 'leave' | 'abort' | 'lost';

/** §6. */
export interface LogBundle {
  gameId: B64; configId: Hex32; lobbyCode: string;
  outcome: GameOutcome;                       // §5.13
  missions: Mission[];                        // as projected (views.ts)
  players: { name: string; uid: Pub }[];      // seat order
  options: { inGameLog: boolean };
  createdAt: number;                          // config envelope t (informational)
}

export interface Bodies {
  'lobby.create': { code: string; name: string; nonce: B64 /* 16 random bytes */ };
  'lobby.join':   { name: string };
  'lobby.leave':  Record<string, never>;
  'lobby.roster': { seq: number; admin: Pub; members: Member[];
                    rejected: { joinId: Hex32; reason: RejectReason }[];
                    closed: boolean };
  'lobby.config': GameConfig;
  key:            { y: Pt; pok: SigmaProofE; seedCommit: Hex32 };
  shuffle:        { deck: CtE[]; c: Pt[]; chat: Pt[]; proof: SigmaProofE };
  deal:           { d: (Pt | null)[]; proof: SigmaProofE };           // d[i] = x_j·A_i, null at i = j
  'ot.recv':      { U: Pt; proof: SigmaProofE };
  'ot.send':      { F: CtE[]; E: (CtE[] | null)[]; profile: SigmaProofE; eq: SigmaProofE; seed: B64 };
  propose:        { team: number[] };                                // seat indices, strictly ascending
  'vote.commit':  { commit: Hex32 };
  'vote.reveal':  { approve: boolean; nonce: B64 };                  // 32 bytes
  ballot:         { ballot: CtE; proof: SigmaProofE };
  tally:          { share: Pt; proof: SigmaProofE };
  assassinate:    { target: number; open: Pt; proof: SigmaProofE };
  cancel:         { at: string; reason: CancelReason };
  reveal:         { x: Sc; ballots: { m: number; r: Sc }[]; basis: Hex32[] };   // basis: §3.7 rule 3
  log:            LogBundle;                                         // §6
}

export interface Envelope<T extends MsgType = MsgType> {
  v: 1;
  type: T;
  lobby: Hex32 | '';     // lobbyId; '' only in lobby.create
  game: B64 | '';        // gameId for game messages and log; '' for lobby messages
  step: string;          // game step id (§3.5); '' for lobby and log messages
  author: Pub;
  /**
   * See the table in §3.2. For `lobby.leave` this implementation uses the joinId
   * of the membership (or pending join request) being ended, see lobby.ts.
   */
  prev: Hex32 | '';
  t: number;             // author's drift-corrected wall clock, ms; informational only
  body: Bodies[T];
}

/** Narrowing helper: `isType(env, 'lobby.roster')` types `env.body`. */
export function isType<T extends MsgType>(env: Envelope, type: T): env is Envelope<T> {
  return env.type === type;
}

// ---------------------------------------------------------------- §11.2 additions

export interface Verdict { ok: boolean; reason?: string }
export interface SetupProgress { stage: 'keys' | 'shuffle' | 'deal' | 'sight'; done: number; total: number; waitingFor: string[] }
export interface UserStats { games: number; good: number; evil: number; wins: number; good_wins: number; evil_wins: number; playtimeSeconds: number }
export interface StoredMsg { msgId: Hex32; env: Envelope; value: string; key: Hex32 }

/** Content-addressed publish/subscribe over the relay (GUN in the browser, in-memory in tests). */
export interface Transport {
  /** Resolves on relay echo; retries internally. */
  publish(soul: string, key: Hex32, value: string): Promise<void>;
  /** Delivers every (key, value) of the soul, including ones that existed before the call. */
  subscribe(soul: string, onValue: (key: string, value: string) => void): () => void;
  /**
   * Optional addition to §11.2: resolves once every value the relay held for
   * the (subscribed) soul when called has been delivered to this subscriber.
   * The SeatDriver awaits it before a cancel without secrets (§3.10), so that
   * its own earlier messages are known before it picks the step to cancel.
   */
  synced?(soul: string): Promise<void>;
}

/** The once-only journal of this device's own signed envelopes (§3.9). */
export interface Journal {
  get(scope: string, slot: string): Promise<string | null>;
  /** Durable before it resolves. */
  put(scope: string, slot: string, value: string): Promise<void>;
  /**
   * Addition to §11.2: atomically stores `value` unless the slot already holds
   * one (one IndexedDB readwrite transaction), durable before it resolves.
   * Returns the value the slot holds afterwards, which is the only one that
   * may be sent: two drivers of one seat (a Web Lock steal, §3.9) can never
   * journal two different envelopes for one slot.
   */
  putIfAbsent(scope: string, slot: string, value: string): Promise<string>;
  all(scope: string): Promise<string[]>;
}
