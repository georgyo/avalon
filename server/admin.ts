import fs from 'fs';
import { Surreal, RecordId } from 'surrealdb';

const db = new Surreal();

async function connectDb(): Promise<Surreal> {
  await db.connect(process.env.SURREAL_URL || 'https://avalon-06b8rurustq696ho5iu0ms1rbk.aws-euw1.surreal.cloud/', {
    namespace: process.env.SURREAL_NS || 'avalon',
    database: process.env.SURREAL_DB || 'avalon',
    authentication: {
      username: process.env.SURREAL_USER || '',
      password: process.env.SURREAL_PASS || '',
    },
  });
  console.log('Connected to SurrealDB');
  return db;
}

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

  // Stats recomputation now done via SurrealDB functions
  // For each log, call the stats function
  for (const log of logs) {
    const playerData = log.players.map(p => ({
      name: p.name,
      uid: p.uid instanceof RecordId ? String(p.uid.id) : String(p.uid).includes(':') ? String(p.uid).split(':').slice(1).join(':') : String(p.uid),
    }));
    try {
      await db.query(
        `fn::compute_and_combine_stats($outcome_state, $outcome_roles, $players, $time_created, $time_finished)`,
        {
          outcome_state: log.outcome.state,
          outcome_roles: log.outcome.roles,
          players: playerData,
          time_created: log.timeCreated ?? null,
          time_finished: log.timeFinished,
        }
      );
    } catch (err) {
      console.error('Failed to compute stats for log:', String(log.id), (err as Error).message);
    }
  }

  console.log('Done recomputing stats');
}

// Keep unused refs to suppress lint while maintaining access for manual use
void _exportLogs;
void _exportLog;
void _cleanupLobbies;
void _cleanupLogs;
void _recomputeAllStats;
