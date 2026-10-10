import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES } from '../avalonlib.ts';
import { legacyAssignRoles } from '../testing/legacyAssignRoles.ts';
import { computeUserStats, emptyUserStats, type HistoryEntry } from './stats.ts';
import type { GameOutcome } from './views.ts';

// ---- Legacy firebase/functions/common/stats.js (git show 52d44ca~1:firebase/functions/common/stats.js),
// ---- computeStats and combineStatEntries ported verbatim (types added, Firestore timestamps as objects).

interface LegacyGame {
  outcome: { state: string; roles: { name: string; role: string }[] };
  players: { name: string; uid: string }[];
  timeCreated: { toMillis(): number };
  timeFinished: { toMillis(): number };
}
type StatEntry = Record<string, number>;

function legacyComputeStats(game: LegacyGame): { users: Record<string, StatEntry>; global: StatEntry } {
  const stats: { users: Record<string, StatEntry>; global: StatEntry } = { users: {}, global: {} };
  stats.global.games = 1;
  stats.global.good_wins = game.outcome.state === 'GOOD_WIN' ? 1 : 0;
  stats.global.playtimeSeconds = (game.timeFinished.toMillis() - game.timeCreated.toMillis()) / 1000;
  for (const player of game.players) {
    const userStats = { games: 1, good: 0, evil: 0, wins: 0, good_wins: 0, evil_wins: 0, playtimeSeconds: 0 };
    const role = game.outcome.roles.find((r) => r.name === player.name)!.role;
    const team = ROLES.find((r) => role === r.name)!.team;
    if (team === 'good') {
      userStats.good = 1;
      userStats.wins = (game.outcome.state === 'GOOD_WIN') ? 1 : 0;
      userStats.good_wins = (game.outcome.state === 'GOOD_WIN') ? 1 : 0;
    } else {
      userStats.evil = 1;
      userStats.wins = (game.outcome.state === 'GOOD_WIN') ? 0 : 1;
      userStats.evil_wins = (game.outcome.state === 'GOOD_WIN') ? 0 : 1;
    }
    userStats.playtimeSeconds = stats.global.playtimeSeconds;
    stats.users[player.uid] = userStats;
  }
  return stats;
}

function combineStatEntries(oldValue: StatEntry | undefined, deltas: StatEntry): StatEntry {
  if (!oldValue) return deltas;
  for (const [statName, statDelta] of Object.entries(deltas)) {
    oldValue[statName] = statDelta + (oldValue[statName] ? oldValue[statName] : 0);
  }
  return oldValue;
}

// ----

function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

const NAMES = ['ALICE', 'BOB', 'CAROL', 'DAVE', 'ERIN', 'FRANK', 'GRACE', 'HEIDI', 'IVAN', 'JUDY'];
const SELECTABLE = ROLES.filter((r) => r.selectable).map((r) => r.name);

function randomGame(r: () => number, id: number): { legacy: LegacyGame; outcome: GameOutcome; start: number; end: number } {
  const n = 5 + Math.floor(r() * 6);
  const players = NAMES.slice(0, n);
  const roles = SELECTABLE.filter(() => r() < 0.5);
  const assigned = legacyAssignRoles(players, roles, r);
  const state = r() < 0.5 ? 'GOOD_WIN' : 'EVIL_WIN';
  const start = 1700000000000 + id * 3600000;
  const end = start + 1000 * Math.floor(r() * 3600);           // whole seconds, as the legacy server's timestamps
  const outcomeRoles = players.map((name) => ({ name, role: assigned[name].role, assassin: assigned[name].assassin }));
  const legacy: LegacyGame = {
    outcome: { state, roles: outcomeRoles },
    players: players.map((name) => ({ name, uid: 'uid-' + name })),
    timeCreated: { toMillis: () => start },
    timeFinished: { toMillis: () => end },
  };
  const outcome: GameOutcome = {
    state, message: 'x', roles: outcomeRoles, votes: [], final: true, unrevealed: [], cheaters: [],
  };
  return { legacy, outcome, start, end };
}

test('computeUserStats equals the legacy computeStats + combineStatEntries for every player', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed);
    const games = Array.from({ length: 1 + Math.floor(r() * 25) }, (_, i) => randomGame(r, i));
    let legacyUsers: Record<string, StatEntry> = {};
    for (const g of games) {
      const st = legacyComputeStats(g.legacy);
      for (const uid of Object.keys(st.users)) legacyUsers = { ...legacyUsers, [uid]: combineStatEntries(legacyUsers[uid], st.users[uid]) };
    }
    for (const name of NAMES) {
      const history: HistoryEntry[] = games
        .filter((g) => g.legacy.players.some((p) => p.name === name))
        .map((g, i) => ({ gameId: `g${i}`, outcome: g.outcome, myName: name, startedAt: g.start, endedAt: g.end }));
      const expected = legacyUsers['uid-' + name] ?? emptyUserStats();
      assert.deepEqual(computeUserStats(history), { ...emptyUserStats(), ...expected }, `seed ${seed} ${name}`);
    }
  }
});

test('only GOOD_WIN/EVIL_WIN games with a known own role count; duplicates once', () => {
  const base: GameOutcome = {
    state: 'GOOD_WIN', message: '', votes: [], final: true, unrevealed: [], cheaters: [],
    roles: [{ name: 'ALICE', role: 'MERLIN' }, { name: 'BOB', role: 'UNKNOWN' }, { name: 'CAROL', role: 'OBERON' }],
  };
  const h = (gameId: string, outcome: GameOutcome, myName: string, ms = 61500): HistoryEntry => ({ gameId, outcome, myName, startedAt: 1000, endedAt: 1000 + ms });
  const stats = computeUserStats([
    h('a', base, 'ALICE'),
    h('a', base, 'ALICE'),                                           // duplicate gameId
    h('b', { ...base, state: 'CANCELED' }, 'ALICE'),                 // canceled
    h('c', base, 'BOB'),                                             // own role unknown
    h('d', base, 'ZED'),                                             // not in the roles
    h('e', { ...base, state: 'EVIL_WIN' }, 'CAROL', -5),             // evil win, negative duration
  ]);
  assert.deepEqual(stats, { games: 2, good: 1, evil: 1, wins: 2, good_wins: 1, evil_wins: 1, playtimeSeconds: 61 });
  assert.deepEqual(computeUserStats([]), emptyUserStats());
});
