import { db } from './surrealdb';

// Simple retry wrapper for db.run() in case of MVCC conflicts
async function dbRun<T = void>(fn: string, args: unknown[] = []): Promise<T> {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.debug("Calling", fn, 'with', args);
      return await db.run<T>(fn, args);
    } catch (err) {
      const msg = (err as Error).message || '';
      // Retry on conflict/contention errors
      if (attempt < maxRetries && (msg.includes('conflict') || msg.includes('contention'))) {
        const delay = Math.min(100 * Math.pow(2, attempt), 1000);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}

export class AvalonApi {
  login(emailAddr: string): Promise<void> {
    return dbRun('fn::login', [emailAddr || null]);
  }

  joinLobby(name: string, lobby: string): Promise<{ lobby: string; name: string }> {
    return dbRun('fn::join_lobby', [name, lobby]);
  }

  createLobby(name: string): Promise<{ lobby: string; name: string }> {
    return dbRun('fn::create_lobby', [name]);
  }

  leaveLobby(lobby: string): Promise<void> {
    return dbRun('fn::leave_lobby', [lobby]);
  }

  kickPlayer(lobby: string, name: string): Promise<void> {
    return dbRun('fn::kick_player', [lobby, name]);
  }

  cancelGame(lobby: string, name: string): Promise<void> {
    return dbRun('fn::cancel_game', [lobby, name]);
  }

  voteTeam(lobby: string, name: string, mission: number, proposal: number, vote: boolean): Promise<void> {
    return dbRun('fn::vote_team', [lobby, mission, proposal, name, vote]);
  }

  startGame(lobby: string, playerList: string[], roles: string[], options: Record<string, unknown>): Promise<void> {
    return dbRun('fn::start_game', [lobby, playerList, roles, options]);
  }

  proposeTeam(lobby: string, name: string, mission: number, proposal: number, team: string[]): Promise<void> {
    return dbRun('fn::propose_team', [lobby, mission, proposal, team]);
  }

  doMission(lobby: string, name: string, mission: number, proposal: number, vote: boolean): Promise<void> {
    return dbRun('fn::do_mission', [lobby, mission, proposal, name, vote]);
  }

  assassinate(lobby: string, name: string, target: string): Promise<void> {
    return dbRun('fn::assassinate', [lobby, name, target]);
  }
}
