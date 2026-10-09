/**
 * Predicts the deal of a simulated game from the seats' game seeds without
 * proving anything (it replays the honest shufflers' derivations, §2.5, §5.3).
 * Test-only: used to search seeds for the non-interference runs (§12).
 */
import { sha256 } from '../crypto/bytes.ts';
import { findLabel } from '../crypto/cards.ts';
import { deriveStream } from '../crypto/derive.ts';
import { reenc } from '../crypto/elgamal.ts';
import { G, mod, mul, mulPub, ptBytes } from '../crypto/group.ts';
import { deckBytes, initialDeck } from '../crypto/shuffle.ts';
import type { CardLabel } from '../crypto/types.ts';
import { beaconProposer } from '../protocol/machine.ts';
import { beaconSeed, secretKey, seedRefOf, type GameSecrets } from '../protocol/private.ts';
import { deriveDeck, distinctLabels } from '../protocol/rules.ts';
import type { GameConfig, Hex32 } from '../protocol/types.ts';

export function predictDeal(config: GameConfig, configId: Hex32, secrets: readonly GameSecrets[]): { labels: CardLabel[]; firstProposer: number } {
  const n = config.seats.length;
  const deckLabels = deriveDeck(n, config.selectedRoles);
  const xs = secrets.map((s) => secretKey(config, s));
  const X = mod(xs.reduce((a, b) => a + b, 0n));
  const Y = mul(G, X);
  let deck = initialDeck(deckLabels);
  for (let j = 0; j < n; j++) {
    const st = deriveStream(seedRefOf(config, secrets[j]), 'shuffle', sha256(ptBytes(Y), deckBytes(deck)));
    const pi = st.perm(n);
    const rho = Array.from({ length: n }, () => st.scalar());
    const input = deck;
    deck = pi.map((src, i) => reenc(Y, input[src], rho[i]));
  }
  const labels = deck.map((c) => {
    const l = findLabel(c.b.subtract(mulPub(c.a, X)), distinctLabels(deckLabels));
    if (l === null) throw new Error('predictDeal: card does not decrypt');
    return l;
  });
  const firstProposer = beaconProposer(configId, secrets.map((s) => beaconSeed(config, s)));
  return { labels, firstProposer };
}
