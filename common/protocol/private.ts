/**
 * The private view of one seat (docs/p2p-protocol.md §5.4-5.5): its own card,
 * decrypted locally with x_j, and its sight list, decoded from the OT answers
 * with β_Q. Nothing here is ever published (§5.11: local uses are not
 * publications); the per-game secrets are derived from gs_j (§2.5).
 */
import { deriveStream, type SeedRef } from '../crypto/derive.ts';
import { mul, type Scalar } from '../crypto/group.ts';
import { otDecode } from '../crypto/ot.ts';
import type { CardLabel } from '../crypto/types.ts';
import { dct, dpt, finalA, labelOfPoint, type GameEval } from './machine.ts';
import { distinctLabels, deriveDeck, roleNamesInPlay } from './rules.ts';
import type { GameConfig } from './types.ts';

export interface GameSecrets { gameSeed: Uint8Array }

export interface PrivateView {
  seat: number;
  label: CardLabel;
  /** Seats this seat sees, ascending (empty until `sightKnown`). */
  seesSeats: number[];
  /** idx(label.role) in N_roles (the OT choice). */
  c: number;
  /** True once the sight exchange (otS) completed and was decoded. Addition to §11.2. */
  sightKnown: boolean;
}

export function seedRefOf(config: GameConfig, secrets: GameSecrets): SeedRef {
  return { gameSeed: secrets.gameSeed, gameId: config.gameId };
}

/** x_j = stream("x").scalar() (§2.5). */
export function secretKey(config: GameConfig, secrets: GameSecrets): Scalar {
  return deriveStream(seedRefOf(config, secrets), 'x').scalar();
}

/** β_Q = stream("ot-beta").scalar() (§2.5). */
export function otBeta(config: GameConfig, secrets: GameSecrets): Scalar {
  return deriveStream(seedRefOf(config, secrets), 'ot-beta').scalar();
}

/** seed_j = stream("seed").bytes(32) (§2.5). */
export function beaconSeed(config: GameConfig, secrets: GameSecrets): Uint8Array {
  return deriveStream(seedRefOf(config, secrets), 'seed').bytes(32);
}

/** This seat's card label once dealing completed, or null. */
export function ownLabel(config: GameConfig, ev: GameEval, seat: number, secrets: GameSecrets): CardLabel | null {
  const s = ev.state;
  const A = finalA(s);
  if (s.C === null || A === null) return null;
  const x = secretKey(config, secrets);
  const M = dpt(s.C[seat]).subtract(mul(dpt(A[seat]), x));
  return labelOfPoint(M, distinctLabels(deriveDeck(config.seats.length, config.selectedRoles)));
}

/**
 * The private view (§5.4-5.5), or null before dealing completed (or if the own
 * card does not decrypt to a label, which valid proofs exclude). Every OT entry
 * addressed to this seat is decoded whatever the role (§9).
 */
export function derivePrivate(config: GameConfig, ev: GameEval, seat: number, secrets: GameSecrets): PrivateView | null {
  const label = ownLabel(config, ev, seat, secrets);
  if (label === null) return null;
  const roleNames = roleNamesInPlay(deriveDeck(config.seats.length, config.selectedRoles));
  const c = roleNames.indexOf(label.role);
  const s = ev.state;
  if (s.E === null) return { seat, label, seesSeats: [], c, sightKnown: false };
  const beta = otBeta(config, secrets);
  const sees: number[] = [];
  for (let P = 0; P < s.n; P++) {
    if (P === seat) continue;
    const row = s.E[P][seat];
    if (row === null) return null;
    const bit = otDecode(beta, dct(row[c]));
    if (bit === null) return null;
    if (bit === 1) sees.push(P);
  }
  return { seat, label, seesSeats: sees, c, sightKnown: true };
}
