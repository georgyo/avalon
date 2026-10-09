/**
 * Test support for the WP-B tests (envelope, lobby, lobbyDriver): deterministic
 * SEA-format key pairs, message construction, an in-memory transport and
 * journal. Not used by protocol code.
 */
import { p256 } from '@noble/curves/nist.js';
import { b64uEncode, sha256, utf8 } from '../crypto/bytes.ts';
import type { Hex32, Pub } from '../crypto/types.ts';
import { decodeEnvelope, encodeEnvelope, signerFromPair, type Signer } from './envelope.ts';
import type { Bodies, Envelope, Journal, MsgType, StoredMsg, Transport } from './types.ts';

export interface TestPair { pub: Pub; priv: string }

/** A deterministic SEA-format P-256 pair for test index `i`. */
export function testPair(i: number): TestPair {
  for (let ctr = 0; ; ctr++) {
    const priv = sha256(utf8(`avalon-test-key/${i}/${ctr}`));
    try {
      const pub = p256.getPublicKey(priv, false);
      return { pub: b64uEncode(pub.slice(1, 33)) + '.' + b64uEncode(pub.slice(33, 65)), priv: b64uEncode(priv) };
    } catch {
      // not a valid secret key; try the next counter
    }
  }
}

export function testSigner(i: number): Signer {
  return signerFromPair(testPair(i));
}

/** Signs, encodes and decodes an envelope (fails the test if it does not round-trip). */
export function makeMsg<T extends MsgType>(
  signer: Signer, type: T, fields: { lobby?: Hex32 | ''; game?: string; step?: string; prev?: Hex32 | ''; t?: number },
  body: Bodies[T],
): StoredMsg {
  const env: Envelope<T> = {
    v: 1, type, lobby: fields.lobby ?? '', game: fields.game ?? '', step: fields.step ?? '',
    author: signer.pub, prev: fields.prev ?? '', t: fields.t ?? 0, body,
  };
  const enc = encodeEnvelope(env, signer);
  const d = decodeEnvelope(enc.value, enc.key);
  if ('error' in d) throw new Error('test message does not decode: ' + d.error);
  return d;
}

/** In-memory relay: stores every (soul, key, value) and delivers it to every subscriber, asynchronously. */
export class FakeRelay {
  private readonly data = new Map<string, Map<string, string>>();
  private readonly subs = new Map<string, Set<(key: string, value: string) => void>>();
  /** Per-peer drop filter: return true to drop a delivery. */
  dropIf: ((soul: string, key: string, value: string) => boolean) | null = null;

  peer(): Transport {
    return {
      publish: async (soul, key, value) => {
        let m = this.data.get(soul);
        if (m === undefined) this.data.set(soul, (m = new Map()));
        if (m.has(key)) return;
        m.set(key, value);
        for (const cb of this.subs.get(soul) ?? []) this.deliver(soul, cb, key, value);
      },
      subscribe: (soul, onValue) => {
        let s = this.subs.get(soul);
        if (s === undefined) this.subs.set(soul, (s = new Set()));
        s.add(onValue);
        for (const [k, v] of this.data.get(soul) ?? []) this.deliver(soul, onValue, k, v);
        return () => {
          s.delete(onValue);
        };
      },
    };
  }

  values(soul: string): string[] {
    return [...(this.data.get(soul)?.values() ?? [])];
  }

  private deliver(soul: string, cb: (key: string, value: string) => void, key: string, value: string): void {
    setTimeout(() => {
      if (this.dropIf !== null && this.dropIf(soul, key, value)) return;
      cb(key, value);
    }, 0);
  }
}

export class MemJournal implements Journal {
  readonly entries = new Map<string, Map<string, string>>();

  async get(scope: string, slot: string): Promise<string | null> {
    return this.entries.get(scope)?.get(slot) ?? null;
  }

  async put(scope: string, slot: string, value: string): Promise<void> {
    let m = this.entries.get(scope);
    if (m === undefined) this.entries.set(scope, (m = new Map()));
    m.set(slot, value);
  }

  async putIfAbsent(scope: string, slot: string, value: string): Promise<string> {
    let m = this.entries.get(scope);
    if (m === undefined) this.entries.set(scope, (m = new Map()));
    const prior = m.get(slot);
    if (prior !== undefined) return prior;
    m.set(slot, value);
    return value;
  }

  async all(scope: string): Promise<string[]> {
    return [...(this.entries.get(scope)?.values() ?? [])];
  }
}
