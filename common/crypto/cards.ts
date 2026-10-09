/**
 * Card points (§2.4): M(λ) = H2C("avalon-p2p/v1/card", utf8(role) ‖ 0x00 ‖ u8(assassin ? 1 : 0)).
 */
import { ROLES } from '../avalonlib.ts';
import { concat, u8, utf8 } from './bytes.ts';
import { CryptoError, G, H2C, ptBytesShared, type Point } from './group.ts';
import type { CardLabel } from './types.ts';

const CARD_TAG = 'avalon-p2p/v1/card';
const cache = new Map<string, Point>();

function labelKey(l: CardLabel): string {
  return l.role + '\u0000' + (l.assassin ? '1' : '0');
}

/** The card point M(λ) (cached). */
export function cardPoint(l: CardLabel): Point {
  if (typeof l.role !== 'string' || typeof l.assassin !== 'boolean') throw new CryptoError('cardPoint: invalid label');
  const key = labelKey(l);
  let P = cache.get(key);
  if (P === undefined) {
    P = H2C(CARD_TAG, concat(utf8(l.role), Uint8Array.of(0), u8(l.assassin ? 1 : 0)));
    cache.set(key, P);
  }
  return P;
}

export function labelEq(a: CardLabel, b: CardLabel): boolean {
  return a.role === b.role && a.assassin === b.assassin;
}

/** The first label whose card point equals P, or null. */
export function findLabel(P: Point, labels: readonly CardLabel[]): CardLabel | null {
  for (const l of labels) if (cardPoint(l).equals(P)) return l;
  return null;
}

/** All labels that can occur: every role with assassin=false, every evil role with assassin=true. */
export function allPossibleLabels(): CardLabel[] {
  return [
    ...ROLES.map((r) => ({ role: r.name, assassin: false })),
    ...ROLES.filter((r) => r.team === 'evil').map((r) => ({ role: r.name, assassin: true })),
  ];
}

/**
 * Startup self-check (§2.4): the points of all possible labels (13 with the
 * current ROLES) are pairwise distinct and differ from O and G. Throws CryptoError.
 */
export function assertCardPointsDistinct(): void {
  const seen = new Set<string>([
    ptBytesShared(G).join(','),
    new Uint8Array(32).join(','),
  ]);
  for (const l of allPossibleLabels()) {
    const P = cardPoint(l);
    if (P.is0() || P.equals(G)) throw new CryptoError(`card point of ${labelKey(l)} is O or G`);
    const k = ptBytesShared(P).join(',');
    if (seen.has(k)) throw new CryptoError(`card point collision for ${l.role}/${l.assassin}`);
    seen.add(k);
  }
}
