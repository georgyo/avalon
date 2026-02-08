import type { Role } from '@avalon/common/avalonlib';

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
  votes: Record<string, Record<string, boolean>>[];
}

export interface GameData {
  state: 'INIT' | 'ACTIVE' | 'COMPLETE';
  phase: string;
  players: string[];
  roles: string[];
  missions: Mission[];
  outcome?: GameOutcome;
  options?: Record<string, unknown>;
}

export interface LobbyUser {
  name: string;
  uid?: string;
}

export interface LobbyData {
  name: string;
  admin: { uid: string; name: string };
  users: Record<string, LobbyUser>;
  game: GameData;
}

export interface UserData {
  uid: string;
  name: string;
  email?: string | null;
  lobby?: string | null;
  stats?: Record<string, unknown>;
}

export interface RoleDoc {
  role: Role;
  sees?: string[];
}

export interface ProposerStats {
  name: string;
  goodProposals: number;
  badProposals: number;
}
