/**
 * View types used by the Vue components (docs/p2p-protocol.md §11.2, §5.13), in the
 * shapes of the pre-P2P client/src/types.ts plus the §5.13 additions. common must
 * not import from client, so they live here; client/src/types.ts re-exports them.
 */
import type { Role } from '../avalonlib.ts';
import type { SetupProgress } from './types.ts';

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
  role: string;            // may be 'UNKNOWN'
  assassin?: boolean;
}

/** §5.13. */
export interface GameOutcome {
  state: 'GOOD_WIN' | 'EVIL_WIN' | 'CANCELED';
  message: string;
  assassinated?: string;
  roles: RoleAssignment[];                 // role may be 'UNKNOWN'
  votes: Record<string, boolean>[];        // votes[m][name] = true for SUCCESS; key absent if unknown
  final: boolean;                          // every role and every vote known
  unrevealed: string[];
  cheaters: { name: string; reason: string }[];
  canceledBy?: string;
  stalled?: string[];
}

export interface GameData {
  state: 'INIT' | 'ACTIVE' | 'ENDED';
  phase: string;
  players: string[];
  roles: string[];
  missions: Mission[];
  outcome?: GameOutcome;
  options?: Record<string, unknown>;
  setup?: SetupProgress;
}

export interface LobbyUser { name: string; uid?: string }

export interface LobbyData {
  name: string;
  admin: { uid: string; name: string };
  users: Record<string, LobbyUser>;
  game: GameData;
  /** Admin only: join requests without an invite ticket, waiting for approval (§4.3). */
  requests?: { joinId: string; name: string }[];
}

export interface RoleDoc { role: Role; assassin: boolean; sees?: string[] }

/** The `lobby.game` value before any config exists (§4.7). */
export function emptyGameData(): GameData {
  return { state: 'INIT', phase: '', players: [], roles: [], missions: [] };
}
