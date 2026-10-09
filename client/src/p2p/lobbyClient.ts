/**
 * Lobby client (docs/p2p-protocol.md §4, §11.2): wraps the protocol's
 * `LobbyDriver` for one lobby, records every verified lobby message (so the
 * session can persist the transcript, §3.4 step 4), and provides lobby
 * discovery by code (§4.2-4.3) and code drawing.
 */
import { randomBytes } from '@avalon/common/crypto';
import {
  LOBBY_ALPHABET, LobbyDriver, candidates as lobbyCandidates, decodeCached, lobbySoul, memberOf, soulOf,
  type Hex32, type Journal, type LobbyCandidate, type LobbyState, type Member, type Pub, type Signer, type StoredMsg,
  type Transport,
} from '@avalon/common/protocol';
import { realTimers, sleep, type Timers } from './env.ts';

/** Join discovery window and code probe window (Appendix B). */
export const DISCOVERY_MS = 3000;
export const PROBE_MS = 1500;
export const MAX_CODE_ATTEMPTS = 5;

/** A random lobby code from `getRandomValues` (§4.2), without modulo bias. */
export function drawCode(): string {
  const n = LOBBY_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = '';
  while (out.length < 4) {
    for (const b of randomBytes(8)) {
      if (b < limit && out.length < 4) out += LOBBY_ALPHABET[b % n];
    }
  }
  return out;
}

/** The decoded message for a (soul, key, value) of a lobby soul, or null. */
export function decodeLobbyValue(code: string, soul: string, key: string, value: string): StoredMsg | null {
  const d = decodeCached(value, key);
  if ('error' in d) return null;
  try {
    if (soulOf(d.env, code) !== soul) return null;
  } catch {
    return null;
  }
  return d;
}

export interface Discovery { candidates: LobbyCandidate[]; msgs: StoredMsg[] }

/** A transport that can tell when a soul has been delivered (GunTransport). */
export interface SyncingTransport extends Transport {
  syncedOk?(soul: string): Promise<boolean>;
}

/**
 * Subscribes to a code's soul and collects the lobbies using it (§4.3). Waits
 * until the transport reports the soul synced, at most `timeoutMs`.
 */
export async function discover(transport: SyncingTransport, code: string, o: { timeoutMs?: number; timers?: Timers } = {}): Promise<Discovery> {
  const timers = o.timers ?? realTimers;
  const soul = lobbySoul(code);
  const msgs = new Map<Hex32, StoredMsg>();
  const unsub = transport.subscribe(soul, (key, value) => {
    const d = decodeLobbyValue(code, soul, key, value);
    if (d !== null) msgs.set(d.msgId, d);
  });
  try {
    const timeout = sleep(timers, o.timeoutMs ?? DISCOVERY_MS);
    const synced = transport.syncedOk !== undefined ? transport.syncedOk(soul).then(() => undefined)
      : transport.synced !== undefined ? transport.synced(soul) : timeout;
    await Promise.race([synced, timeout]);
  } finally {
    unsub();
  }
  const all = [...msgs.values()];
  return { candidates: lobbyCandidates(code, all), msgs: all };
}

export interface LobbyClientOptions {
  code: string;
  lobbyId: Hex32 | null;
  signer: Signer;
  transport: Transport;
  journal: Journal;
  now: () => number;
  onState(s: LobbyState): void;
  /** Every verified message of this lobby, once (transcript persistence). */
  onMessage?(m: StoredMsg, soul: string): void;
}

export class LobbyClient {
  readonly code: string;
  readonly soul: string;
  readonly driver: LobbyDriver;
  private readonly o: LobbyClientOptions;
  private readonly seen = new Set<Hex32>();
  private started = false;

  constructor(o: LobbyClientOptions) {
    this.o = o;
    this.code = o.code;
    this.soul = lobbySoul(o.code);
    const t = o.transport;
    const recording: Transport = {
      publish: (soul, key, value) => t.publish(soul, key, value),
      subscribe: (soul, onValue) => t.subscribe(soul, (key, value) => {
        onValue(key, value);
        this.record(soul, key, value);
      }),
      synced: t.synced === undefined ? undefined : (soul) => (t.synced as (s: string) => Promise<void>)(soul),
    };
    this.driver = new LobbyDriver({
      code: o.code, lobbyId: o.lobbyId, signer: o.signer, transport: recording, journal: o.journal, now: o.now,
      onState: (s) => o.onState(s),
    });
  }

  private record(soul: string, key: string, value: string): void {
    const cb = this.o.onMessage;
    if (cb === undefined) return;
    const d = decodeLobbyValue(this.code, soul, key, value);
    if (d === null || this.seen.has(d.msgId)) return;
    const lobbyId = this.driver.lobbyId;
    // Only this lobby's messages (the soul carries every lobby that used the code).
    if (lobbyId !== null && d.msgId !== lobbyId && d.env.lobby !== lobbyId) return;
    this.seen.add(d.msgId);
    cb(d, soul);
  }

  get lobbyId(): Hex32 | null {
    return this.driver.lobbyId;
  }

  get state(): LobbyState | null {
    return this.driver.state;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.driver.start();
  }

  stop(): void {
    this.driver.stop();
  }

  /** Feeds known messages (cached transcript, discovery) into the driver. */
  ingest(msgs: Iterable<{ key: string; value: string }>): void {
    for (const m of msgs) {
      if (this.driver.ingest(this.soul, m.key, m.value)) this.record(this.soul, m.key, m.value);
    }
  }

  /** This lobby's messages (for a full republish, §7.4). */
  messages(): StoredMsg[] {
    const id = this.driver.lobbyId;
    return this.driver.messages().filter((m) => id === null || m.msgId === id || m.env.lobby === id);
  }

  /** Re-puts every journaled lobby message of this device (§7.4). */
  async republishJournal(): Promise<void> {
    const id = this.driver.lobbyId;
    if (id === null) return;
    const values = await this.o.journal.all(id);
    for (const value of values) {
      const d = decodeCached(value);
      if ('error' in d) continue;
      this.o.transport.publish(this.soul, d.key, d.value).catch(() => undefined);
    }
  }

  /** Re-puts this lobby's whole verified transcript (relay restarted empty, §7.4). */
  republishAll(): void {
    for (const m of this.messages()) this.o.transport.publish(this.soul, m.key, m.value).catch(() => undefined);
  }

  member(pub: Pub): Member | undefined {
    const s = this.driver.state;
    return s === null ? undefined : memberOf(s, pub);
  }
}
