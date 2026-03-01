import { RecordId } from 'surrealdb';
import { ROLES } from '@avalon/common';
import { db } from './surrealdb';

interface GameLogData {
  outcome: {
    state: 'GOOD_WIN' | 'EVIL_WIN' | 'CANCELED';
    roles: { name: string; role: string; assassin: boolean }[];
  };
  players: { name: string; uid: string }[];
  timeCreated?: string;
  timeFinished: string;
}

interface StatEntry {
  games?: number;
  good?: number;
  evil?: number;
  wins?: number;
  good_wins?: number;
  evil_wins?: number;
  playtimeSeconds?: number;
  [key: string]: number | undefined;
}

interface Stats {
  users: Record<string, StatEntry>;
  global: StatEntry;
}

function combineStatEntries(oldValue: StatEntry | undefined, deltas: StatEntry): StatEntry {
  if (!oldValue) {
    return deltas;
  }
  for (const [statName, statDelta] of Object.entries(deltas)) {
    if (typeof statDelta === 'number') {
      oldValue[statName] = statDelta + (oldValue[statName] ?? 0);
    }
  }
  return oldValue;
}

export function computeStats(game: GameLogData): Stats {
  const stats: Stats = {
    users: {},
    global: {}
  };

  const timeCreated = game.timeCreated ? new Date(game.timeCreated).getTime() : 0;
  const timeFinished = new Date(game.timeFinished).getTime();

  stats.global.games = 1;
  stats.global.good_wins = game.outcome.state === 'GOOD_WIN' ? 1 : 0;
  stats.global.playtimeSeconds = timeCreated ? (timeFinished - timeCreated) / 1000 : 0;

  for (const player of game.players) {
    const userStats: StatEntry = {
      games: 1,
      good: 0,
      evil: 0,
      wins: 0,
      good_wins: 0,
      evil_wins: 0,
      playtimeSeconds: 0
    };

    const role = game.outcome.roles.find(r => r.name === player.name)?.role;
    const team = ROLES.find(r => role === r.name)?.team;

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

async function combineGlobalStats(stats: StatEntry): Promise<void> {
  const result = await db.query<[{ id: RecordId }[]]>(
    'SELECT * FROM stats WHERE id = $id',
    { id: new RecordId('stats', 'global') }
  );
  const existing = result[0]?.[0] as (StatEntry & { id: RecordId }) | undefined;

  const globalData = combineStatEntries(existing ? { ...existing } : {}, stats);
  delete (globalData as Record<string, unknown>)['id'];

  if (existing) {
    await db.query(
      'UPDATE stats SET games = $games, good_wins = $good_wins, playtimeSeconds = $playtimeSeconds WHERE id = $id',
      {
        id: new RecordId('stats', 'global'),
        games: globalData.games ?? 0,
        good_wins: globalData.good_wins ?? 0,
        playtimeSeconds: globalData.playtimeSeconds ?? 0,
      }
    );
  } else {
    await db.query(
      'CREATE stats SET id = $id, games = $games, good_wins = $good_wins, playtimeSeconds = $playtimeSeconds',
      {
        id: new RecordId('stats', 'global'),
        games: globalData.games ?? 0,
        good_wins: globalData.good_wins ?? 0,
        playtimeSeconds: globalData.playtimeSeconds ?? 0,
      }
    );
  }
}

async function combineUserStats(userStats: Record<string, StatEntry>): Promise<void> {
  for (const [uid, statDeltas] of Object.entries(userStats)) {
    const result = await db.query<[{ stats?: StatEntry }[]]>(
      'SELECT stats FROM user WHERE id = $id',
      { id: new RecordId('user', uid) }
    );
    const userDoc = result[0]?.[0];
    if (!userDoc) {
      console.log("Skipping non-existent user", uid);
      continue;
    }

    const userStatRecord = combineStatEntries(userDoc.stats ?? {}, statDeltas);
    await db.query(
      'UPDATE user SET stats = $stats WHERE id = $id',
      { id: new RecordId('user', uid), stats: userStatRecord }
    );
  }
}

export async function computeAndCombineStats(game: GameLogData): Promise<void> {
  const stats = computeStats(game);
  await combineGlobalStats(stats.global);
  await combineUserStats(stats.users);
}
