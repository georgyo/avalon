/**
 * Subscription manager (docs/p2p-protocol.md §7.3): one GUN subscription per
 * soul per GUN instance, shared by any number of local watchers.
 *
 * * content-addressed souls: `gun.get(soul).map().on(h)`;
 * * presence: `gun.get('~' + pub).get('avalon_v1_presence').on(p)`.
 *
 * `.once` is never used and `.off()` is never called (it tears down shared
 * chains): a watcher that unsubscribes only stops receiving callbacks. When the
 * subscribed set must shrink, the owner creates a fresh GUN instance and a new
 * manager (GunTransport.rebuild()).
 */
import type { GunHandle } from './gun.ts';

export type Unsub = () => void;

interface SoulSub {
  values: Map<string, string>;
  watchers: Set<(key: string, value: string) => void>;
  lastDelivery: number;
}

interface UserSub {
  value: string | null;
  watchers: Set<(value: string) => void>;
}

/** A presence value as GUN delivers it: the plain string, or (older GUN paths) the signed `{":": v, "~": sig}` JSON. */
export function unpackUserValue(data: unknown): string | null {
  if (typeof data !== 'string') return null;
  if (data.startsWith('SEA{') || data.startsWith('{":"')) {
    try {
      const parsed: unknown = JSON.parse(data.startsWith('SEA') ? data.slice(3) : data);
      if (typeof parsed === 'object' && parsed !== null) {
        const inner = (parsed as Record<string, unknown>)[':'] ?? (parsed as Record<string, unknown>).m;
        if (typeof inner === 'string') return inner;
      }
    } catch {
      return data;
    }
  }
  return data;
}

export class SubscriptionManager {
  private readonly souls = new Map<string, SoulSub>();
  private readonly users = new Map<string, UserSub>();
  /** Every soul subscribed, in order (metadata checks, §9). */
  readonly order: string[] = [];

  constructor(readonly handle: GunHandle, private readonly now: () => number = Date.now) {}

  /** Watches a content-addressed soul; values already known are replayed to the new watcher. */
  watch(soul: string, cb: (key: string, value: string) => void): Unsub {
    let sub = this.souls.get(soul);
    if (sub === undefined) {
      const created: SoulSub = { values: new Map(), watchers: new Set(), lastDelivery: 0 };
      sub = created;
      this.souls.set(soul, created);
      this.order.push(soul);
      this.handle.gun.get(soul).map().on((data, key) => {
        if (typeof data !== 'string' || typeof key !== 'string') return;
        if (created.values.get(key) === data) return;
        created.values.set(key, data);
        created.lastDelivery = this.now();
        for (const w of [...created.watchers]) {
          try {
            w(key, data);
          } catch (e) {
            console.error('subscription watcher failed', e);
          }
        }
      });
    }
    const s = sub;
    s.watchers.add(cb);
    for (const [k, v] of [...s.values]) {
      if (!s.watchers.has(cb)) break;
      cb(k, v);
    }
    return () => {
      s.watchers.delete(cb);
    };
  }

  /** Watches a key of a user's space (presence, §7.6). */
  watchUser(pub: string, key: string, cb: (value: string) => void): Unsub {
    const id = '~' + pub + '\u0000' + key;
    let sub = this.users.get(id);
    if (sub === undefined) {
      const created: UserSub = { value: null, watchers: new Set() };
      sub = created;
      this.users.set(id, created);
      this.order.push('~' + pub);
      this.handle.gun.get('~' + pub).get(key).on((data) => {
        const v = unpackUserValue(data);
        if (v === null || v === created.value) return;
        created.value = v;
        for (const w of [...created.watchers]) {
          try {
            w(v);
          } catch (e) {
            console.error('presence watcher failed', e);
          }
        }
      });
    }
    const s = sub;
    s.watchers.add(cb);
    if (s.value !== null) cb(s.value);
    return () => {
      s.watchers.delete(cb);
    };
  }

  /** Re-asks souls from the relay (§7.3 backstop). Returns the message id per soul. */
  reask(souls: Iterable<string>): Map<string, string> {
    const ids = new Map<string, string>();
    for (const soul of souls) ids.set(soul, this.handle.reask(soul));
    return ids;
  }

  /** Souls with at least one active watcher. */
  activeSouls(): string[] {
    return [...this.souls].filter(([, s]) => s.watchers.size > 0).map(([soul]) => soul);
  }

  /** Every soul this manager subscribed to (active or not). */
  allSouls(): string[] {
    return [...this.souls.keys()];
  }

  /** Users (pub, key) with at least one active watcher. */
  activeUsers(): { pub: string; key: string }[] {
    const out: { pub: string; key: string }[] = [];
    for (const [id, s] of this.users) {
      if (s.watchers.size === 0) continue;
      const [soul, key] = id.split('\u0000');
      out.push({ pub: soul.slice(1), key });
    }
    return out;
  }

  /** Values known for a soul. */
  known(soul: string): ReadonlyMap<string, string> {
    return this.souls.get(soul)?.values ?? new Map();
  }

  lastDelivery(soul: string): number {
    return this.souls.get(soul)?.lastDelivery ?? 0;
  }

  isWatching(soul: string): boolean {
    return this.souls.has(soul);
  }
}
