import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';

import axios, { AxiosResponse } from 'axios';

export class AvalonApi {
  constructor() {
    axios.defaults.baseURL = "/api";
  }

  post(endPoint: string, data: Record<string, any>): Promise<AxiosResponse> {
    return firebase.auth().currentUser!.getIdToken(false).then(function(idToken: string) {
      console.debug("Calling", endPoint, 'with', data);
      return axios.post(endPoint, data, {
        headers: {'X-Avalon-Auth': idToken}
      }).catch(err => {
        if (err.response && err.response.data.message) {
          throw new Error(err.response.data.message);
        } else {
          throw err;
        }
      });
    });
  }

  login(emailAddr: string): Promise<AxiosResponse> {
    return this.post('login', {email: emailAddr});
  }

  joinLobby(name: string, lobby: string): Promise<AxiosResponse> {
    return this.post('joinLobby', { name, lobby});
  }

  createLobby(name: string): Promise<AxiosResponse> {
    return this.post('createLobby', { name } );
  }

  leaveLobby(lobby: string): Promise<AxiosResponse> {
    return this.post('leaveLobby', { lobby });
  }

  kickPlayer(lobby: string, name: string): Promise<AxiosResponse> {
    return this.post('kickPlayer', { lobby, name });
  }

  cancelGame(lobby: string, name: string): Promise<AxiosResponse> {
    return this.post('cancelGame', { lobby, name });
  }

  voteTeam(lobby: string, name: string, mission: number, proposal: number, vote: boolean): Promise<AxiosResponse> {
    return this.post('voteTeam',
      {
        lobby,
        name,
        mission,
        proposal,
        vote
      });
  }

  startGame(lobby: string, playerList: string[], roles: string[], options: Record<string, any>): Promise<AxiosResponse> {
    return this.post('startGame', {lobby, playerList, roles, options });
  }

  proposeTeam(lobby: string, name: string, mission: number, proposal: number, team: string[]): Promise<AxiosResponse> {
    return this.post('proposeTeam', { lobby, name, mission, proposal, team });
  }

  doMission(lobby: string, name: string, mission: number, proposal: number, vote: boolean): Promise<AxiosResponse> {
    return this.post('doMission', { lobby, name, mission, proposal, vote });
  }

  assassinate(lobby: string, name: string, target: string): Promise<AxiosResponse> {
    return this.post('assassinate', { lobby, name, target });
  }
}
