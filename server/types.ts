import type { firestore } from 'firebase-admin';

// Firestore document data types

export interface LobbyUser {
  name: string;
  uid: string;
}

export interface Proposal {
  proposer: string;
  state: 'PENDING' | 'APPROVED' | 'REJECTED';
  team: string[];
  votes: string[];
}

export interface Mission {
  state: 'PENDING' | 'SUCCESS' | 'FAIL';
  teamSize: number;
  failsRequired: number;
  team: string[];
  proposals: Proposal[];
  numFails?: number;
}

export interface GameOutcome {
  state: 'GOOD_WIN' | 'EVIL_WIN' | 'CANCELED';
  message: string;
  assassinated: string | null;
  roles: { name: string; role: string; assassin: boolean }[];
  votes: Record<string, boolean>[];
}

export interface Game {
  state: 'INIT' | 'ACTIVE' | 'ENDED';
  phase?: 'TEAM_PROPOSAL' | 'PROPOSAL_VOTE' | 'MISSION_VOTE' | 'ASSASSINATION';
  timeCreated?: firestore.Timestamp;
  missions: Mission[];
  players: string[];
  roles: string[];
  options?: Record<string, unknown>;
  outcome?: GameOutcome;
}

export interface LobbyData {
  admin: { uid: string; name: string };
  timeCreated: firestore.Timestamp;
  users: Record<string, LobbyUser>;
  game: Game;
}

export interface SecretVotes {
  mission: Record<string, boolean>[];
  proposal: Record<string, boolean>;
}

export interface PlayerRole {
  name: string;
  role: string;
  assassin: boolean;
  team: 'good' | 'evil';
  sees: string[];
}

export interface SecretStateData {
  roles: Record<string, PlayerRole>;
  votes: SecretVotes;
}

export interface UserData {
  uid: string;
  email?: string;
  name?: string;
  lobby?: string;
  lastActive?: firestore.FieldValue;
  created?: firestore.FieldValue;
  logs?: string[];
}

// Request payload types

export interface LoginData {
  email?: string;
}

export interface LobbyActionData {
  lobby: string;
  name: string;
}

export interface JoinLobbyData {
  lobby: string;
  name: string;
}

export interface StartGameData {
  lobby: string;
  playerList: string[];
  roles: string[];
  options?: Record<string, unknown>;
}

export interface TeamProposalData {
  lobby: string;
  mission: number;
  proposal: number;
  team: string[];
}

export interface VoteData {
  lobby: string;
  mission: number;
  proposal: number;
  name: string;
  vote: boolean;
}

export interface AssassinateData {
  lobby: string;
  name: string;
  target: string;
}

// Custom error

export class AvalonError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}
