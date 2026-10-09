/**
 * Local per-user stats (docs/p2p-protocol.md §6): a port of the legacy
 * firebase/functions/common/stats.js `computeStats` (per-user part), summed over
 * this device's finished games like the legacy `combineStatEntries`.
 */
import type { B64 } from '../crypto/types.ts';
import { isRoleName, teamOf } from './rules.ts';
import type { UserStats } from './types.ts';
import type { GameOutcome } from './views.ts';

export interface HistoryEntry { gameId: B64; outcome: GameOutcome; myName: string; startedAt: number; endedAt: number }

export function emptyUserStats(): UserStats {
  return { games: 0, good: 0, evil: 0, wins: 0, good_wins: 0, evil_wins: 0, playtimeSeconds: 0 };
}

/** Whole seconds of a millisecond duration (negative durations count as 0); integer arithmetic. */
function wholeSeconds(ms: number): number {
  if (!Number.isSafeInteger(ms) || ms <= 0) return 0;
  return (ms - (ms % 1000)) / 1000;
}

/**
 * Only GOOD_WIN / EVIL_WIN games in which this device's own role is known count
 * (§6). Duplicate gameIds count once. `playtimeSeconds` is the sum of whole
 * seconds from `startedAt` (key completion) to `endedAt` (terminal), local time.
 */
export function computeUserStats(history: readonly HistoryEntry[]): UserStats {
  const stats = emptyUserStats();
  const counted = new Set<string>();
  for (const h of history) {
    if (counted.has(h.gameId)) continue;
    const { state } = h.outcome;
    if (state !== 'GOOD_WIN' && state !== 'EVIL_WIN') continue;
    const role = h.outcome.roles.find((r) => r.name === h.myName)?.role;
    if (role === undefined || !isRoleName(role)) continue;
    counted.add(h.gameId);
    const goodWon = state === 'GOOD_WIN' ? 1 : 0;
    stats.games += 1;
    if (teamOf(role) === 'good') {
      stats.good += 1;
      stats.wins += goodWon;
      stats.good_wins += goodWon;
    } else {
      stats.evil += 1;
      stats.wins += 1 - goodWon;
      stats.evil_wins += 1 - goodWon;
    }
    stats.playtimeSeconds += wholeSeconds(h.endedAt - h.startedAt);
  }
  return stats;
}
