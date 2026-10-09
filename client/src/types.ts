import type { Role } from '@avalon/common/avalonlib';
import type { UserStats } from '@avalon/common/protocol';

export type { Role };

// The view types are defined once, in common/protocol/views.ts (docs/p2p-protocol.md §11.2), and
// re-exported here for the components.
export type {
  Proposal, Mission, RoleAssignment, GameOutcome, GameData, LobbyUser, LobbyData, RoleDoc,
  SetupProgress, UserStats, LobbyCandidate,
} from '@avalon/common/protocol';

export interface UserData {
  uid: string;                   // the device's SEA pub
  name: string;                  // profile name ('' until a lobby was created or joined)
  email: null;                   // email login was removed (anonymous device keys only)
  lobby: string | null;          // lobby CODE
  stats: UserStats | null;
}

export interface ProposerStats {
  name: string;
  goodProposals: number;
  badProposals: number;
}
