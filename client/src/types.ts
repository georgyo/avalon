import type { Role } from '@avalon/common/avalonlib';
import type { UserStats } from './p2p-fake';

export type { Role };

// The view types are defined once, in common/protocol/views.ts (docs/p2p-protocol.md §11.2), and
// re-exported here for the components. Until WP-B and WP-D are merged they come from the temporary
// mirror in ./p2p-fake.ts. INTEGRATION: replace './p2p-fake' with '@avalon/common/protocol' in both
// import lines of this file.
export type {
  Proposal, Mission, RoleAssignment, GameOutcome, GameData, LobbyUser, LobbyData, RoleDoc,
  SetupProgress, UserStats, LobbyCandidate,
} from './p2p-fake';

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
