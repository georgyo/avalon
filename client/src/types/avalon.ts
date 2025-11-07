// Type definitions for Avalon game

export type Team = 'good' | 'evil'
export type ProposalState = 'PENDING' | 'APPROVED' | 'REJECTED'
export type MissionState = 'PENDING' | 'SUCCESS' | 'FAIL'
export type GameState = 'INIT' | 'ACTIVE' | 'ENDED'
export type GamePhase = 'TEAM_PROPOSAL' | 'TEAM_VOTE' | 'MISSION' | 'ASSASSINATION' | 'GAME_OVER'
export type OutcomeState = 'GOOD_WIN' | 'EVIL_WIN' | 'CANCELED'

export interface Role {
  name: string
  team: Team
  description: string
  seesEvil?: boolean
  canAssassinate?: boolean
}

export interface RoleMap {
  [roleName: string]: Role
}

export interface Config {
  roles: Role[]
  roleMap: RoleMap
  playerList: string[]
  selectableRoles: Role[]
  sortList: (list: string[]) => void
}

export interface User {
  uid: string
  name: string
  email: string
  stats?: UserStats
  lobby?: string
}

export interface UserStats {
  games: number
  wins: number
  losses: number
  [key: string]: any
}

export interface GlobalStats {
  [key: string]: any
}

export interface Admin {
  name: string
  uid: string
}

export interface LobbyUser {
  name: string
  uid: string
}

export interface LobbyUsers {
  [username: string]: LobbyUser
}

export interface Proposal {
  proposer: string
  state: ProposalState
  team: string[]
  votes: Vote[]
}

export interface Vote {
  name: string
  vote: boolean
}

export interface Mission {
  state: MissionState
  team: string[]
  numFails: number
  proposals: Proposal[]
}

export interface RoleAssignment {
  name: string
  role: string
  sees: string[]
  assassin?: boolean
  role_obj?: Role
}

export interface GameOutcome {
  state: OutcomeState
  message: string
  assassinated?: string
  roles: Array<{
    name: string
    role: string
    assassin?: boolean
  }>
  votes: any[]
}

export interface GameData {
  state: GameState
  phase?: GamePhase
  players: string[]
  roles: string[]
  missions: Mission[]
  currentMissionIdx?: number
  outcome?: GameOutcome
}

export interface Game extends GameData {
  game: GameData
  roleInfos?: Role[]
  numPlayers?: number
  currentMission: Mission | null
  currentMissionIdx: number
  currentProposal: Proposal | null
  currentProposalIdx: number
  currentProposer: string | null
  hammer: string | null
  lastProposal: Proposal | null
  numEvil: number
  numGood: number
  roleMap?: RoleMap
  getNumTeam: (team: Team) => number
}

export interface LobbyData {
  name: string
  admin: Admin
  users: LobbyUsers
  game: GameData
}

export interface LobbyRole {
  role: Role
  sees: string[]
  assassin?: boolean
}

export interface Lobby {
  name: string
  admin: Admin
  users: LobbyUsers
  game: Game
  role?: LobbyRole
}

export type EventCallback = (...args: any[]) => void

export interface AvalonInstance {
  initialized: boolean
  isLoggedIn: boolean
  isInLobby: boolean
  isGameInProgress: boolean
  isAdmin: boolean
  user: User | null
  lobby: Lobby | null
  game: Game | null
  config: Config
  globalStats: GlobalStats | null
  init: () => Promise<void>
  loginWithEmail: (email: string) => Promise<void>
  loginAnonymously: () => Promise<void>
  createLobby: (name: string) => Promise<void>
  joinLobby: (name: string, lobby: string) => Promise<void>
  leaveLobby: () => Promise<void>
  kickPlayer: (name: string) => Promise<void>
  startGame: (options: any) => Promise<void>
  cancelGame: () => Promise<void>
  proposeTeam: (team: string[]) => Promise<void>
  voteTeam: (vote: boolean) => Promise<void>
  doMission: (vote: boolean) => Promise<void>
  assassinate: (target: string) => Promise<void>
}
