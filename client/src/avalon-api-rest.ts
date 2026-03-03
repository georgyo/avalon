import { API_BASE } from './surrealdb';

async function apiCall<T = void>(path: string, body?: Record<string, unknown>): Promise<T> {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const token = localStorage.getItem('avalon_auth_token');
    if (!token) throw new Error('Not authenticated');

    const response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body ?? {}),
    });

    if (response.ok) return (await response.json()) as T;

    let errorMessage: string;
    try {
      const errBody = await response.json();
      // SurrealDB wraps THROW errors as "An error occurred: <message>"
      errorMessage = typeof errBody === 'string'
        ? errBody.replace(/^An error occurred: /, '')
        : errBody.error || errBody.description || response.statusText;
    } catch {
      errorMessage = response.statusText;
    }

    if (attempt < maxRetries && (errorMessage.includes('conflict') || errorMessage.includes('contention'))) {
      await new Promise(r => setTimeout(r, Math.min(100 * Math.pow(2, attempt), 1000)));
      continue;
    }
    throw new Error(errorMessage);
  }
  throw new Error('Unreachable');
}

export class AvalonApi {
  login(emailAddr: string): Promise<void> {
    return apiCall('/login', { email: emailAddr || null });
  }

  joinLobby(name: string, lobby: string): Promise<{ lobby: string; name: string }> {
    return apiCall(`/lobby/${lobby}/join`, { name });
  }

  createLobby(name: string): Promise<{ lobby: string; name: string }> {
    return apiCall('/lobby', { name });
  }

  leaveLobby(lobby: string): Promise<void> {
    return apiCall(`/lobby/${lobby}/leave`);
  }

  kickPlayer(lobby: string, name: string): Promise<void> {
    return apiCall(`/lobby/${lobby}/kick`, { name });
  }

  cancelGame(lobby: string, name: string): Promise<void> {
    return apiCall(`/lobby/${lobby}/cancel`, { name });
  }

  voteTeam(lobby: string, name: string, mission: number, proposal: number, vote: boolean): Promise<void> {
    return apiCall(`/lobby/${lobby}/vote-team`, { mission, proposal, name, vote });
  }

  startGame(lobby: string, playerList: string[], roles: string[], options: Record<string, unknown>): Promise<void> {
    return apiCall(`/lobby/${lobby}/start`, { player_list: playerList, roles, options });
  }

  proposeTeam(lobby: string, name: string, mission: number, proposal: number, team: string[]): Promise<void> {
    return apiCall(`/lobby/${lobby}/propose`, { mission, proposal, team });
  }

  doMission(lobby: string, name: string, mission: number, proposal: number, vote: boolean): Promise<void> {
    return apiCall(`/lobby/${lobby}/vote-mission`, { mission, proposal, name, vote });
  }

  assassinate(lobby: string, name: string, target: string): Promise<void> {
    return apiCall(`/lobby/${lobby}/assassinate`, { name, target });
  }
}
