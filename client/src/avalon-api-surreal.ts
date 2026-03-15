import { Surreal } from 'surrealdb';

export class AvalonApi {
  private db: Surreal;

  constructor(db: Surreal) {
    this.db = db;
  }

  private async post(endpoint: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    console.debug("Calling", endpoint, 'with', data);
    try {
      const result = await this.db.api().post('/' + endpoint, data).value();
      return (result ?? {}) as Record<string, unknown>;
    } catch (err) {
      // Extract error message from API error responses
      if (err && typeof err === 'object' && 'response' in err) {
        const response = (err as { response?: { body?: { message?: string } } }).response;
        if (response?.body?.message) {
          throw new Error(response.body.message);
        }
      }
      throw err;
    }
  }

  login(): Promise<Record<string, unknown>> {
    return this.post('login', {});
  }

  joinLobby(name: string, lobby: string): Promise<Record<string, unknown>> {
    return this.post('joinLobby', { name, lobby });
  }

  createLobby(name: string): Promise<Record<string, unknown>> {
    return this.post('createLobby', { name });
  }

  leaveLobby(lobby: string): Promise<Record<string, unknown>> {
    return this.post('leaveLobby', { lobby });
  }

  kickPlayer(lobby: string, name: string): Promise<Record<string, unknown>> {
    return this.post('kickPlayer', { lobby, name });
  }

  cancelGame(lobby: string, name: string): Promise<Record<string, unknown>> {
    return this.post('cancelGame', { lobby, name });
  }

  voteTeam(lobby: string, name: string, mission: number, proposal: number, vote: boolean): Promise<Record<string, unknown>> {
    return this.post('voteTeam', { lobby, name, mission, proposal, vote });
  }

  startGame(lobby: string, playerList: string[], roles: string[], options: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post('startGame', { lobby, playerList, roles, options });
  }

  proposeTeam(lobby: string, name: string, mission: number, proposal: number, team: string[]): Promise<Record<string, unknown>> {
    return this.post('proposeTeam', { lobby, name, mission, proposal, team });
  }

  doMission(lobby: string, name: string, mission: number, proposal: number, vote: boolean): Promise<Record<string, unknown>> {
    return this.post('doMission', { lobby, name, mission, proposal, vote });
  }

  assassinate(lobby: string, name: string, target: string): Promise<Record<string, unknown>> {
    return this.post('assassinate', { lobby, name, target });
  }
}
