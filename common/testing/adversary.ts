/**
 * Cheating support for simulations (docs/p2p-protocol.md §10, §12): an
 * Adversary controls one seat. Its honest driver builds messages as usual;
 * `rewrite` replaces every envelope the seat publishes (null = unchanged,
 * [] = withhold, several = equivocate), and `onEval` may inject arbitrary
 * extra messages after each evaluation of its driver. Rewritten envelopes are
 * signed with the seat's key WITHOUT schema validation (`rawEncode`), so
 * malformed messages can be produced too.
 */
import { b64uEncode, canon, hexEncode, sha256, utf8 } from '../crypto/bytes.ts';
import type { SeedRef } from '../crypto/derive.ts';
import { decodeEnvelope, gameSoul, gunKeyOf, sigInput, type Signer } from '../protocol/envelope.ts';
import type { GameEval } from '../protocol/machine.ts';
import type { SeatDriver } from '../protocol/driver.ts';
import type { GameSecrets } from '../protocol/private.ts';
import { PLAY_MSG_TYPES, SETUP_MSG_TYPES, type Envelope, type GameConfig, type Hex32, type Transport } from '../protocol/types.ts';

export interface AdversaryContext {
  config: GameConfig;
  configId: Hex32;
  lobbyId: Hex32;
  lobbyCode: string;
  seat: number;
  signer: Signer;
  secrets: GameSecrets;
  seed: SeedRef;
  /** Signs (without schema validation) and publishes an envelope to the soul of its type. Returns its msgId. */
  publish(env: unknown): Hex32;
  /** The adversary seat's current driver. */
  driver(): SeatDriver;
  /** Every seat's current driver (simulation omniscience, e.g. to time an attack). */
  drivers(): SeatDriver[];
}

export interface Adversary {
  seat: number;
  /** Replaces an envelope the seat is about to publish: null = publish unchanged, [] = withhold. */
  rewrite(env: Envelope, view: GameEval): Envelope[] | null;
  init?(ctx: AdversaryContext): void;
  /** Called after every evaluation of the adversary's driver. */
  onEval?(view: GameEval, ctx: AdversaryContext): void;
}

const MSG_TAG = utf8('avalon-p2p/v1/msg\0');

/** Signs any JSON value as an envelope value (no schema check). */
export function rawEncode(env: unknown, signer: Signer): { value: string; key: Hex32; msgId: Hex32 } {
  const mBytes = utf8(canon(env));
  const id = sha256(MSG_TAG, mBytes);
  const sig = signer.sign(sigInput(id));
  const value = 'AV1.' + b64uEncode(mBytes) + '.' + b64uEncode(sig);
  return { value, key: gunKeyOf(value), msgId: hexEncode(id) };
}

/** The game soul of a (possibly malformed) game envelope: by type, falling back to play. */
export function soulForRaw(env: { type?: unknown; game?: unknown }, gameId: string): string {
  const t = typeof env.type === 'string' ? env.type : '';
  if ((SETUP_MSG_TYPES as readonly string[]).includes(t)) return gameSoul(gameId, 'setup');
  if ((PLAY_MSG_TYPES as readonly string[]).includes(t)) return gameSoul(gameId, 'play');
  return gameSoul(gameId, 'play');
}

/** A transport that routes the adversary seat's own publishes through `rewrite`. */
export class AdversaryTransport implements Transport {
  private readonly cache = new Map<Hex32, { soul: string; key: Hex32; value: string }[]>();
  /** Values this transport produced: re-puts of them pass through unchanged. */
  private readonly produced = new Set<Hex32>();

  constructor(
    private readonly inner: Transport,
    private readonly adv: Adversary,
    private readonly signer: Signer,
    private readonly gameId: string,
    private readonly view: () => GameEval | null,
  ) {}

  publish(soul: string, key: Hex32, value: string): Promise<void> {
    const d = decodeEnvelope(value, key);
    if ('error' in d || d.env.author !== this.signer.pub || d.env.game !== this.gameId || this.produced.has(key)) {
      return this.inner.publish(soul, key, value);
    }
    let out = this.cache.get(d.msgId);
    if (out === undefined) {
      const ev = this.view();
      const r = ev === null ? null : this.adv.rewrite(d.env, ev);
      out = r === null
        ? [{ soul, key, value }]
        : r.map((e) => {
          const enc = rawEncode(e, this.signer);
          return { soul: soulForRaw(e, this.gameId), key: enc.key, value: enc.value };
        });
      this.cache.set(d.msgId, out);
      for (const x of out) this.produced.add(x.key);
    }
    for (const x of out) this.inner.publish(x.soul, x.key, x.value).catch(() => undefined);
    return Promise.resolve();
  }

  /** Publishes directly (no rewrite). */
  publishRaw(soul: string, key: Hex32, value: string): Promise<void> {
    this.produced.add(key);
    return this.inner.publish(soul, key, value);
  }

  subscribe(soul: string, onValue: (key: string, value: string) => void): () => void {
    return this.inner.subscribe(soul, onValue);
  }
}

/** A deep copy of an envelope (for rewrites). */
export function cloneEnv<T extends Envelope>(env: T): T {
  return JSON.parse(JSON.stringify(env)) as T;
}

/** A different valid-looking scalar/point string: flips the last base64url character's low bit (may be non-canonical). */
export function tweakB64(s: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const c = s[0];
  const i = alphabet.indexOf(c);
  return alphabet[(i + 1) % 64] + s.slice(1);
}
