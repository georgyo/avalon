/**
 * Anonymous per-device identity (docs/p2p-protocol.md §1, §3.3, §3.9): a SEA
 * key pair stored in IndexedDB `identity`, the protocol `Signer` derived from
 * it, and the GUN user authentication used for presence writes (§7.6).
 *
 * The pair has SEA's exact shape (`pub`/`epub` = "x.y" in base64url, `priv`/
 * `epriv` = d in base64url). It is generated with noble's P-256, which is
 * synchronous and needs no WebCrypto, and is accepted by `gun.user().auth(pair)`.
 */
import { p256 } from '@noble/curves/nist.js';
import { b64uEncode } from '@avalon/common/crypto';
import { signerFromPair, type Pub, type Signer } from '@avalon/common/protocol';
import type { SeaPair } from './gun.ts';
import type { IdentityRecord, Store } from './store.ts';

export interface Identity {
  pair: SeaPair;
  pub: Pub;
  signer: Signer;
  created: number;
}

function keyPair(): { pub: string; priv: string } {
  const sk = p256.utils.randomSecretKey();
  const pk = p256.getPublicKey(sk, false); // 0x04 ‖ x ‖ y
  return { pub: b64uEncode(pk.slice(1, 33)) + '.' + b64uEncode(pk.slice(33, 65)), priv: b64uEncode(sk) };
}

/** A fresh SEA-compatible pair (signing pair + encryption pair, both P-256). */
export function newPair(): SeaPair {
  const s = keyPair();
  const e = keyPair();
  return { pub: s.pub, priv: s.priv, epub: e.pub, epriv: e.priv };
}

function identityOf(r: IdentityRecord): Identity {
  return { pair: r.pair, pub: r.pair.pub, signer: signerFromPair(r.pair), created: r.created };
}

/** The stored identity, or null. A stored pair that does not verify is treated as corrupt (throws). */
export async function loadIdentity(store: Store): Promise<Identity | null> {
  const r = await store.identity.get();
  return r === null ? null : identityOf(r);
}

/** Loads the identity, creating and storing a new pair if none exists. */
export async function loadOrCreateIdentity(store: Store, now: () => number = Date.now): Promise<Identity> {
  const existing = await loadIdentity(store);
  if (existing !== null) return existing;
  const r: IdentityRecord = { pair: newPair(), created: now() };
  await store.identity.put(r);
  // Another tab may have raced us: whatever is stored wins.
  const stored = await store.identity.get();
  return identityOf(stored ?? r);
}

/**
 * Forgets this device's identity and everything tied to it (games, journal,
 * transcript, verdicts, history, profile): a pair is never kept without its
 * seeds and vice versa (§3.9). The caller refuses while a game is non-terminal.
 */
export async function resetIdentity(store: Store): Promise<void> {
  await store.clearAll();
}
