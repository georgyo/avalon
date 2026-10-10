/**
 * The decryption allow-list oracle (docs/p2p-protocol.md §5.11, §12): with the
 * simulation's knowledge of every x_j, look for any published point x_j·B, for
 * B any public point, in a message of seat j before its reveal, and check it
 * against the four allowed publications (plus y_j = x_j·G at `key`).
 */
import { decPoint, G, GEN, L, mod, mulPub } from '../crypto/group.ts';
import { dpt, ept, finalA } from '../protocol/machine.ts';
import { secretKey } from '../protocol/private.ts';
import type { StoredMsg } from '../protocol/types.ts';
import type { SimResult } from './simulate.ts';
import { msgMap } from './transcript.ts';

const PROOF_KEYS = new Set(['pok', 'proof', 'profile', 'eq']);

/** Every encoded point in a JSON value (strings that decode as points); proofs skipped if asked. */
function collectPoints(v: unknown, skipProofs: boolean, out: Set<string>, key = ''): void {
  if (skipProofs && PROOF_KEYS.has(key)) return;
  if (typeof v === 'string') {
    if (v.length !== 43) return;
    try {
      decPoint(v);
      out.add(v);
    } catch {
      // not a point
    }
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectPoints(x, skipProofs, out, key);
    return;
  }
  if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) collectPoints(x, skipProofs, out, k);
}

/**
 * The publications of x_j·B by the seats not in `skip` (adversaries) that the
 * allow-list does not permit, as readable strings (empty when the run is clean).
 */
export function allowListViolations(r: SimResult, skip: readonly number[] = []): string[] {
  const msgs = msgMap(r.transcript, r.config.gameId);
  const ev = r.ev;
  if (ev === null) return [];
  const s = ev.state;
  const pub = new Set<string>();
  for (const m of msgs.values()) if (m.env.type !== 'reveal' && m.env.type !== 'log') collectPoints(m.env.body, true, pub);
  for (const c of s.C ?? []) pub.add(c);
  for (const ms of s.missions) if (ms.T !== null) pub.add(ms.T);
  for (const P of [G, GEN.S, GEN.J, GEN.H0, ...GEN.H]) pub.add(ept(P));
  const A = finalA(s);
  const out: string[] = [];
  const n = r.config.seats.length;
  for (let j = 0; j < n; j++) {
    if (skip.includes(j)) continue;
    const x = secretKey(r.config, r.secrets[j]);
    const mine: StoredMsg[] = [...msgs.values()]
      .filter((m) => m.env.author === r.config.seats[j].pub && m.env.type !== 'reveal' && m.env.type !== 'log');
    // P = x_j·B for a public B iff x_j⁻¹·P is public: one multiplication per own point.
    const xInv = powMod(x, L - 2n);
    for (const m of mine) {
      const ps = new Set<string>();
      collectPoints(m.env.body, false, ps);
      const step = m.env.step;
      for (const P of ps) {
        const B = ept(mulPub(dpt(P), xInv));
        if (!pub.has(B)) continue;
        const allowed = (step === 'key' && B === ept(G))
          || (step === 'deal' && A !== null && A.some((a, i) => a === B && i !== j))
          || (/^mt\/\d+$/.test(step) && s.missions[Number(step.slice(3))]?.T === B)
          || (step === 'as' && A !== null && A[j] === B);
        if (!allowed) out.push(`seat ${j} published x_j·${B.slice(0, 10)}… at ${step}`);
      }
    }
  }
  return out;
}

function powMod(b: bigint, e: bigint): bigint {
  let r = 1n;
  let x = mod(b);
  let k = e;
  while (k > 0n) {
    if ((k & 1n) === 1n) r = mod(r * x);
    x = mod(x * x);
    k >>= 1n;
  }
  return r;
}
