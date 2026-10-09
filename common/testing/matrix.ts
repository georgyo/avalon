/**
 * The role-combination matrix (docs/p2p-protocol.md §12): every subset of the
 * selectable roles is played to the end. By default each subset is played once
 * at n = 5 + (mask mod 6) with a rotating strategy (64 games over 4 files);
 * with AVALON_SIM_FULL=1 every (n, subset) pair is played (384 games; within a
 * part, pairs with an identical deck are played once).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES } from '../avalonlib.ts';
import { deriveDeck } from '../protocol/rules.ts';
import { simulate, type StrategyName } from './simulate.ts';
import { assertHonestGame } from './simkit.ts';

const SELECTABLE = ROLES.filter((r) => r.selectable).map((r) => r.name);
const STRATEGIES: StrategyName[] = ['good-wins', 'evil-wins', 'merlin-dies'];

export interface MatrixCase { n: number; roles: string[]; strategy: StrategyName; seed: number }

export function matrixCases(part: number, parts: number, full: boolean): MatrixCase[] {
  const out: MatrixCase[] = [];
  const seenDecks = new Set<string>();
  for (let mask = 0; mask < 1 << SELECTABLE.length; mask++) {
    // Parts by the high bits (OBERON, ASSASSIN), so every part mixes MERLIN/PERCIVAL/MORGANA/MORDRED.
    if ((parts === 4 ? mask >> 4 : mask % parts) !== part) continue;
    const roles = SELECTABLE.filter((_, i) => (mask & (1 << i)) !== 0);
    const ns = full ? [5, 6, 7, 8, 9, 10] : [5 + (mask % 6)];
    for (const n of ns) {
      const key = n + JSON.stringify(deriveDeck(n, roles));
      if (full && seenDecks.has(key)) continue;
      seenDecks.add(key);
      out.push({ n, roles, strategy: STRATEGIES[(mask + n) % STRATEGIES.length], seed: 1000 + mask * 16 + n });
    }
  }
  return out;
}

export function registerMatrix(part: number, parts = 4): void {
  const full = process.env.AVALON_SIM_FULL === '1';
  for (const c of matrixCases(part, parts, full)) {
    test(`n=${c.n} roles=[${c.roles.join(',')}] ${c.strategy}`, async () => {
      const r = await simulate({ n: c.n, roles: c.roles, seed: c.seed, strategy: c.strategy });
      const out = assertHonestGame(r);
      assert.ok(out.state === 'GOOD_WIN' || out.state === 'EVIL_WIN');
      if (c.strategy === 'evil-wins') assert.equal(out.state, 'EVIL_WIN');
      else assert.equal(out.state, c.strategy === 'merlin-dies' && c.roles.includes('MERLIN') ? 'EVIL_WIN' : 'GOOD_WIN');
      // The public role list is the deck in canonical order.
      assert.deepEqual(r.seats[0].view?.game.roles, deriveDeck(c.n, c.roles).map((l) => l.role));
    });
  }
}
