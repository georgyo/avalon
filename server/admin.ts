import fs from 'fs';
import { connectDb, db } from './surrealdb';
import { computeAndCombineStats, computeStats } from './stats';
import { RecordId } from 'surrealdb';

interface GameLogRecord {
  id: RecordId;
  missions: unknown[];
  outcome: {
    state: 'GOOD_WIN' | 'EVIL_WIN' | 'CANCELED';
    roles: { name: string; role: string; assassin: boolean }[];
  };
  players: { name: string; uid: RecordId | string }[];
  options?: Record<string, unknown>;
  timeCreated?: string;
  timeFinished: string;
}

async function _exportLogs(): Promise<void> {
  await connectDb();
  const result = await db.query<[GameLogRecord[]]>('SELECT * FROM game_log');
  const logs = result[0] ?? [];
  for (const log of logs) {
    const id = typeof log.id === 'object' ? String(log.id) : log.id;
    fs.writeFileSync(String(id), JSON.stringify(log, null, ' '));
  }
  console.log(`Exported ${logs.length} logs`);
}

async function _exportLog(logId: string): Promise<void> {
  await connectDb();
  const result = await db.query<[GameLogRecord[]]>(
    'SELECT * FROM game_log WHERE id = $id',
    { id: new RecordId('game_log', logId) }
  );
  const log = result[0]?.[0];
  if (log) {
    fs.writeFileSync(logId, JSON.stringify(log, null, ' '));
    console.log('Exported', logId);
  } else {
    console.log('Log not found:', logId);
  }
}

async function _cleanupLobbies(): Promise<void> {
  await connectDb();
  const result = await db.query<[{ count: number }[]]>(
    `DELETE FROM lobby WHERE
      (timeCreated < time::now() - 2d AND game.state = 'INIT')
      OR timeCreated < time::now() - 7d
    RETURN BEFORE`
  );
  const deleted = result[0]?.length ?? 0;
  console.log(`Deleted ${deleted} lobbies`);
}

async function _cleanupLogs(): Promise<void> {
  await connectDb();
  const result = await db.query<[{ count: number }[]]>(
    'DELETE FROM game_log WHERE timeCreated < time::now() - 60d RETURN BEFORE'
  );
  const deleted = result[0]?.length ?? 0;
  console.log(`Deleted ${deleted} logs`);
}

async function _recomputeAllStats(): Promise<void> {
  await connectDb();

  // Reset global stats
  await db.query('DELETE FROM stats');

  // Reset user stats
  await db.query('UPDATE user SET stats = {}');

  // Recompute from all logs
  const result = await db.query<[GameLogRecord[]]>('SELECT * FROM game_log');
  const logs = result[0] ?? [];

  console.log('Recomputing stats from', logs.length, 'logs');

  // Combine all stats
  const combinedStats: { users: Record<string, Record<string, number>>; global: Record<string, number> } = {
    users: {},
    global: {}
  };

  for (const log of logs) {
    const stats = computeStats(log);
    // Combine global
    for (const [key, val] of Object.entries(stats.global)) {
      if (typeof val === 'number') {
        combinedStats.global[key] = (combinedStats.global[key] ?? 0) + val;
      }
    }
    // Combine user stats
    for (const [uid, userStats] of Object.entries(stats.users)) {
      if (!combinedStats.users[uid]) combinedStats.users[uid] = {};
      for (const [key, val] of Object.entries(userStats)) {
        if (typeof val === 'number') {
          combinedStats.users[uid][key] = (combinedStats.users[uid][key] ?? 0) + val;
        }
      }
    }
  }

  // Write combined global stats
  await db.query(
    'CREATE stats SET id = $id, games = $games, good_wins = $good_wins, playtimeSeconds = $playtimeSeconds',
    {
      id: new RecordId('stats', 'global'),
      games: combinedStats.global.games ?? 0,
      good_wins: combinedStats.global.good_wins ?? 0,
      playtimeSeconds: combinedStats.global.playtimeSeconds ?? 0,
    }
  );

  // Write combined user stats
  for (const [uid, stats] of Object.entries(combinedStats.users)) {
    await db.query(
      'UPDATE user SET stats = $stats WHERE id = $id',
      { id: new RecordId('user', uid), stats }
    );
  }

  console.log('Done recomputing stats');
}

// Keep unused refs to suppress lint while maintaining access for manual use
void _exportLogs;
void _exportLog;
void _cleanupLobbies;
void _cleanupLogs;
void _recomputeAllStats;
void computeAndCombineStats;
