import type { Role } from '@avalon/common/avalonlib';
import type { RecordId } from 'surrealdb';

export type { Role };

export interface Proposal {
  proposer: string;
  team: string[];
  votes: string[];
  state: 'PENDING' | 'APPROVED' | 'REJECTED';
}

export interface Mission {
  state: 'PENDING' | 'SUCCESS' | 'FAIL';
  team: string[];
  teamSize: number;
  failsRequired: number;
  numFails: number;
  proposals: Proposal[];
  evilOnTeam?: string[];
}

export interface RoleAssignment {
  name: string;
  role: string;
  assassin?: boolean;
}

export interface GameOutcome {
  state: 'GOOD_WIN' | 'EVIL_WIN' | 'CANCELED';
  message: string;
  assassinated?: string;
  roles: RoleAssignment[];
  votes: Record<string, boolean>[];
}

export interface GameData {
  state: 'INIT' | 'ACTIVE' | 'ENDED';
  phase: string;
  players: string[];
  roles: string[];
  missions: Mission[];
  outcome?: GameOutcome;
  options?: Record<string, unknown>;
}

export interface LobbyUser {
  name: string;
  uid?: string | RecordId;
}

export interface LobbyData {
  id?: RecordId;
  admin: { uid: string | RecordId; name: string };
  users: Record<string, LobbyUser>;
  game: GameData;
}

export interface UserData {
  id?: RecordId;
  uid: string;
  name: string;
  lobby?: RecordId | null;
  stats?: Record<string, unknown>;
}

export interface RoleDoc {
  role: Role;
  sees?: string[];
  assassin?: boolean;
}

export interface PlayerRoleData {
  id?: RecordId;
  lobby: RecordId;
  user: RecordId;
  name: string;
  role: string;
  assassin: boolean;
  team: string;
  sees: string[];
}

export interface ProposerStats {
  name: string;
  goodProposals: number;
  badProposals: number;
}
