/**
 * Local persistence (docs/p2p-protocol.md §3.9, §3.10): the IndexedDB
 * database `avalon` (version 1) behind a small `KV` interface, so that node
 * tests use an in-memory implementation.
 *
 * | Store        | Key                 | Value |
 * |--------------|---------------------|-------|
 * | `identity`   | `'self'`            | `{ pair, created }` |
 * | `profile`    | `'self'`            | `{ name, lobbyCode, lobbyId }` |
 * | `games`      | `gameId`            | `GameRecord` |
 * | `journal`    | `[scopeId, slot]`   | own signed envelope value |
 * | `transcript` | `msgId`             | `{ soul, key, value, scope }` (index `scope`: gameId or lobbyId) |
 * | `verdicts`   | `jobId`             | `{ ok, reason? }` |
 * | `history`    | `gameId`            | `HistoryEntry` (§6) |
 *
 * `identity` and `games` live in one database, so clearing site data removes
 * both together. Every storage error is reported through `onError` (the
 * session then shows LOST_SECRETS) and rethrown: nothing "continues anyway".
 */
import type { HistoryEntry, Hex32, Journal, Verdict } from '@avalon/common/protocol';
import type { SeaPair } from './gun.ts';

export type StoreName = 'identity' | 'profile' | 'games' | 'journal' | 'transcript' | 'verdicts' | 'history';
export const STORE_NAMES: readonly StoreName[] = ['identity', 'profile', 'games', 'journal', 'transcript', 'verdicts', 'history'];
export type KVKey = string | [string, string];

/** The key-value backend: IndexedDB in browsers, memory in node tests. Values are structured-cloneable. */
export interface KV {
  get(store: StoreName, key: KVKey): Promise<unknown>;
  getMany(store: StoreName, keys: readonly KVKey[]): Promise<unknown[]>;
  put(store: StoreName, key: KVKey, value: unknown): Promise<void>;
  /** Atomically stores `value` unless the key holds one; returns the value held afterwards. */
  putIfAbsent(store: StoreName, key: KVKey, value: unknown): Promise<unknown>;
  delete(store: StoreName, key: KVKey): Promise<void>;
  /** Values whose key is `[prefix, *]` (journal), in key order. */
  byPrefix(store: StoreName, prefix: string): Promise<unknown[]>;
  /** Values whose `scope` field equals `scope` (transcript). */
  byScope(store: StoreName, scope: string): Promise<unknown[]>;
  all(store: StoreName): Promise<unknown[]>;
  clear(stores: readonly StoreName[]): Promise<void>;
  close?(): void;
}

// ---------------------------------------------------------------- records

export interface IdentityRecord { pair: SeaPair; created: number }
export interface ProfileRecord { name: string | null; lobbyCode: string | null; lobbyId: Hex32 | null }
export type GameStatus = 'active' | 'ended' | 'abandoned' | 'lost' | 'superseded';
export interface GameRecord {
  gameId: string;
  lobbyId: Hex32;
  configId: Hex32;
  seat: number;
  /** gs_j, base64url (§2.5). */
  seed: string;
  status: GameStatus;
  startedAt: number;
  endedAt?: number;
  /** Addition: the lobby code, so a game can be resumed after leaving its lobby. */
  lobbyCode?: string;
  /** Addition: local time of `key` completion (stats playtime, §6). */
  keyCompletedAt?: number;
}
export interface TranscriptRecord { soul: string; key: Hex32; value: string; scope: string }

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

function isPair(v: unknown): v is SeaPair {
  return isObj(v) && isStr(v.pub) && isStr(v.priv) && isStr(v.epub) && isStr(v.epriv);
}

export function isIdentityRecord(v: unknown): v is IdentityRecord {
  return isObj(v) && isPair(v.pair) && typeof v.created === 'number';
}

function isProfileRecord(v: unknown): v is ProfileRecord {
  return isObj(v) && (v.name === null || isStr(v.name)) && (v.lobbyCode === null || isStr(v.lobbyCode))
    && (v.lobbyId === null || isStr(v.lobbyId));
}

const GAME_STATUSES: readonly string[] = ['active', 'ended', 'abandoned', 'lost', 'superseded'];

function isGameRecord(v: unknown): v is GameRecord {
  return isObj(v) && isStr(v.gameId) && isStr(v.lobbyId) && isStr(v.configId) && typeof v.seat === 'number' && isStr(v.seed)
    && isStr(v.status) && GAME_STATUSES.includes(v.status) && typeof v.startedAt === 'number';
}

function isTranscriptRecord(v: unknown): v is TranscriptRecord {
  return isObj(v) && isStr(v.soul) && isStr(v.key) && isStr(v.value) && isStr(v.scope);
}

function isVerdict(v: unknown): v is Verdict {
  return isObj(v) && typeof v.ok === 'boolean' && (v.reason === undefined || isStr(v.reason));
}

function isHistoryEntry(v: unknown): v is HistoryEntry {
  return isObj(v) && isStr(v.gameId) && isObj(v.outcome) && isStr(v.myName) && typeof v.startedAt === 'number'
    && typeof v.endedAt === 'number';
}

// ---------------------------------------------------------------- memory KV

function keyString(key: KVKey): string {
  return typeof key === 'string' ? 's:' + key : 'a:' + JSON.stringify(key);
}

/** In-memory KV (node tests; also the fallback when IndexedDB is missing). Copies values like IndexedDB does. */
export class MemoryKV implements KV {
  private readonly data = new Map<StoreName, Map<string, { key: KVKey; value: unknown }>>();
  /** When set, every call rejects with it (tests of the LOST_SECRETS path). */
  failWith: Error | null = null;

  private map(store: StoreName): Map<string, { key: KVKey; value: unknown }> {
    let m = this.data.get(store);
    if (m === undefined) {
      m = new Map();
      this.data.set(store, m);
    }
    return m;
  }

  private check(): void {
    if (this.failWith !== null) throw this.failWith;
  }

  async get(store: StoreName, key: KVKey): Promise<unknown> {
    this.check();
    const hit = this.map(store).get(keyString(key));
    return hit === undefined ? undefined : structuredClone(hit.value);
  }

  async getMany(store: StoreName, keys: readonly KVKey[]): Promise<unknown[]> {
    this.check();
    const m = this.map(store);
    return keys.map((k) => {
      const hit = m.get(keyString(k));
      return hit === undefined ? undefined : structuredClone(hit.value);
    });
  }

  async put(store: StoreName, key: KVKey, value: unknown): Promise<void> {
    this.check();
    this.map(store).set(keyString(key), { key, value: structuredClone(value) });
  }

  async putIfAbsent(store: StoreName, key: KVKey, value: unknown): Promise<unknown> {
    this.check();
    const m = this.map(store);
    const k = keyString(key);
    const hit = m.get(k);
    if (hit !== undefined) return structuredClone(hit.value);
    m.set(k, { key, value: structuredClone(value) });
    return structuredClone(value);
  }

  async delete(store: StoreName, key: KVKey): Promise<void> {
    this.check();
    this.map(store).delete(keyString(key));
  }

  async byPrefix(store: StoreName, prefix: string): Promise<unknown[]> {
    this.check();
    const rows = [...this.map(store).values()].filter((r) => Array.isArray(r.key) && r.key[0] === prefix);
    rows.sort((a, b) => (a.key[1] < b.key[1] ? -1 : a.key[1] > b.key[1] ? 1 : 0));
    return rows.map((r) => structuredClone(r.value));
  }

  async byScope(store: StoreName, scope: string): Promise<unknown[]> {
    this.check();
    return [...this.map(store).values()]
      .filter((r) => isObj(r.value) && r.value.scope === scope)
      .map((r) => structuredClone(r.value));
  }

  async all(store: StoreName): Promise<unknown[]> {
    this.check();
    return [...this.map(store).values()].map((r) => structuredClone(r.value));
  }

  async clear(stores: readonly StoreName[]): Promise<void> {
    this.check();
    for (const s of stores) this.map(s).clear();
  }
}

// ---------------------------------------------------------------- IndexedDB KV

export const DB_NAME = 'avalon';
export const DB_VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** Opens (and on first use creates) the `avalon` database. */
export function openIndexedDb(factory: IDBFactory = indexedDB, name = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = factory.open(name, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const s of STORE_NAMES) {
        if (db.objectStoreNames.contains(s)) continue;
        const os = db.createObjectStore(s);
        if (s === 'transcript') os.createIndex('scope', 'scope', { unique: false });
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('cannot open IndexedDB'));
    r.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
  });
}

/**
 * KV over IndexedDB. Writes resolve when their transaction completed (durable:
 * the journal entry is committed before the envelope is put, §3.9).
 */
export class IndexedDbKV implements KV {
  constructor(private readonly db: IDBDatabase) {}

  static async open(factory?: IDBFactory, name?: string): Promise<IndexedDbKV> {
    return new IndexedDbKV(await openIndexedDb(factory, name));
  }

  private tx(stores: StoreName | StoreName[], mode: IDBTransactionMode): IDBTransaction {
    return this.db.transaction(stores, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
  }

  async get(store: StoreName, key: KVKey): Promise<unknown> {
    return req(this.tx(store, 'readonly').objectStore(store).get(key));
  }

  async getMany(store: StoreName, keys: readonly KVKey[]): Promise<unknown[]> {
    if (keys.length === 0) return [];
    const tx = this.tx(store, 'readonly');
    const os = tx.objectStore(store);
    const out: unknown[] = new Array<unknown>(keys.length);
    keys.forEach((k, i) => {
      const r = os.get(k);
      r.onsuccess = () => {
        out[i] = r.result;
      };
    });
    await done(tx);
    return out;
  }

  async put(store: StoreName, key: KVKey, value: unknown): Promise<void> {
    const tx = this.tx(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    await done(tx);
  }

  async putIfAbsent(store: StoreName, key: KVKey, value: unknown): Promise<unknown> {
    const tx = this.tx(store, 'readwrite');
    const os = tx.objectStore(store);
    const finished = done(tx);
    let result: unknown = value;
    // Read and write in one readwrite transaction, inside the request callback (atomic).
    const r = os.get(key);
    r.onsuccess = () => {
      if (r.result === undefined) os.put(value, key);
      else result = r.result;
    };
    await finished;
    return result;
  }

  async delete(store: StoreName, key: KVKey): Promise<void> {
    const tx = this.tx(store, 'readwrite');
    tx.objectStore(store).delete(key);
    await done(tx);
  }

  async byPrefix(store: StoreName, prefix: string): Promise<unknown[]> {
    // Array keys sort after strings, so [prefix] .. [prefix, []] covers every [prefix, slot].
    const range = IDBKeyRange.bound([prefix], [prefix, []]);
    return req(this.tx(store, 'readonly').objectStore(store).getAll(range));
  }

  async byScope(store: StoreName, scope: string): Promise<unknown[]> {
    return req(this.tx(store, 'readonly').objectStore(store).index('scope').getAll(scope));
  }

  async all(store: StoreName): Promise<unknown[]> {
    return req(this.tx(store, 'readonly').objectStore(store).getAll());
  }

  async clear(stores: readonly StoreName[]): Promise<void> {
    const tx = this.tx([...stores], 'readwrite');
    for (const s of stores) tx.objectStore(s).clear();
    await done(tx);
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------- the typed store

export class StoreError extends Error {}

export interface Store {
  readonly kv: KV;
  readonly identity: {
    get(): Promise<IdentityRecord | null>;
    put(r: IdentityRecord): Promise<void>;
  };
  readonly profile: {
    get(): Promise<ProfileRecord>;
    put(r: ProfileRecord): Promise<void>;
  };
  readonly games: {
    get(gameId: string): Promise<GameRecord | null>;
    put(r: GameRecord): Promise<void>;
    /** Writes the record unless one exists for the gameId; returns the record held afterwards. */
    putIfAbsent(r: GameRecord): Promise<GameRecord>;
    all(): Promise<GameRecord[]>;
  };
  readonly journal: Journal;
  readonly transcript: {
    add(msgId: Hex32, r: TranscriptRecord): Promise<void>;
    get(msgId: Hex32): Promise<TranscriptRecord | null>;
    forScope(scope: string): Promise<(TranscriptRecord & { msgId?: Hex32 })[]>;
  };
  readonly verdicts: {
    get(jobId: Hex32): Promise<Verdict | null>;
    getMany(jobIds: readonly Hex32[]): Promise<Map<Hex32, Verdict>>;
    put(jobId: Hex32, v: Verdict): Promise<void>;
  };
  readonly history: {
    put(e: HistoryEntry): Promise<void>;
    all(): Promise<HistoryEntry[]>;
  };
  /** Removes the identity and everything tied to it (logout, §3.9). */
  clearAll(): Promise<void>;
  /** True once any storage call failed (LOST_SECRETS, §3.9). */
  readonly failed: boolean;
}

export interface OpenStoreOptions {
  kv?: KV;
  onError?: (e: unknown) => void;
  /** Ask the browser to keep the data (navigator.storage.persist, §3.9). Default true. */
  persist?: boolean;
}

const EMPTY_PROFILE: ProfileRecord = { name: null, lobbyCode: null, lobbyId: null };

/** Opens the store: IndexedDB in browsers (calls navigator.storage.persist()), or the given KV. */
export async function openStore(o: OpenStoreOptions = {}): Promise<Store> {
  let kv = o.kv;
  if (kv === undefined) {
    if (typeof indexedDB === 'undefined') throw new StoreError('IndexedDB is not available');
    kv = await IndexedDbKV.open();
    if (o.persist !== false && typeof navigator !== 'undefined' && navigator.storage?.persist !== undefined) {
      navigator.storage.persist().catch(() => undefined);
    }
  }
  return createStore(kv, o.onError);
}

/** The typed store over a KV. */
export function createStore(kv: KV, onError?: (e: unknown) => void): Store {
  let failed = false;
  const guard = async <T>(p: () => Promise<T>): Promise<T> => {
    try {
      return await p();
    } catch (e) {
      failed = true;
      onError?.(e);
      throw e instanceof Error ? e : new StoreError(String(e));
    }
  };
  const SELF = 'self';
  return {
    kv,
    get failed() {
      return failed;
    },
    identity: {
      get: () => guard(async () => {
        const v = await kv.get('identity', SELF);
        return isIdentityRecord(v) ? v : null;
      }),
      put: (r) => guard(() => kv.put('identity', SELF, r)),
    },
    profile: {
      get: () => guard(async () => {
        const v = await kv.get('profile', SELF);
        return isProfileRecord(v) ? v : { ...EMPTY_PROFILE };
      }),
      put: (r) => guard(() => kv.put('profile', SELF, r)),
    },
    games: {
      get: (gameId) => guard(async () => {
        const v = await kv.get('games', gameId);
        return isGameRecord(v) ? v : null;
      }),
      put: (r) => guard(() => kv.put('games', r.gameId, r)),
      putIfAbsent: (r) => guard(async () => {
        const v = await kv.putIfAbsent('games', r.gameId, r);
        if (!isGameRecord(v)) throw new StoreError('corrupt games record ' + r.gameId);
        return v;
      }),
      all: () => guard(async () => (await kv.all('games')).filter(isGameRecord)),
    },
    journal: {
      get: (scope, slot) => guard(async () => {
        const v = await kv.get('journal', [scope, slot]);
        return isStr(v) ? v : null;
      }),
      put: (scope, slot, value) => guard(() => kv.put('journal', [scope, slot], value)),
      putIfAbsent: (scope, slot, value) => guard(async () => {
        const v = await kv.putIfAbsent('journal', [scope, slot], value);
        if (!isStr(v)) throw new StoreError(`corrupt journal entry ${scope}/${slot}`);
        return v;
      }),
      all: (scope) => guard(async () => (await kv.byPrefix('journal', scope)).filter(isStr)),
    },
    transcript: {
      add: (msgId, r) => guard(async () => {
        await kv.putIfAbsent('transcript', msgId, r);
      }),
      get: (msgId) => guard(async () => {
        const v = await kv.get('transcript', msgId);
        return isTranscriptRecord(v) ? v : null;
      }),
      forScope: (scope) => guard(async () => (await kv.byScope('transcript', scope)).filter(isTranscriptRecord)),
    },
    verdicts: {
      get: (jobId) => guard(async () => {
        const v = await kv.get('verdicts', jobId);
        return isVerdict(v) ? v : null;
      }),
      getMany: (jobIds) => guard(async () => {
        const vs = await kv.getMany('verdicts', jobIds);
        const out = new Map<Hex32, Verdict>();
        vs.forEach((v, i) => {
          if (isVerdict(v)) out.set(jobIds[i], v.reason === undefined ? { ok: v.ok } : { ok: v.ok, reason: v.reason });
        });
        return out;
      }),
      put: (jobId, v) => guard(() => kv.put('verdicts', jobId, v.reason === undefined ? { ok: v.ok } : { ok: v.ok, reason: v.reason })),
    },
    history: {
      put: (e) => guard(() => kv.put('history', e.gameId, e)),
      all: () => guard(async () => (await kv.all('history')).filter(isHistoryEntry)),
    },
    clearAll: () => guard(() => kv.clear(STORE_NAMES)),
  };
}
