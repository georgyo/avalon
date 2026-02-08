import mitt from 'mitt'

type Events = {
  LOBBY_CONNECTED: void
  LOBBY_NEW_ADMIN: void
  GAME_STARTED: void
  GAME_ENDED: void
  MISSION_RESULT: void
  PROPOSAL_REJECTED: void
  PROPOSAL_APPROVED: void
  TEAM_PROPOSED: void
  PLAYER_LEFT: string
  PLAYER_JOINED: string
  DISCONNECTED_FROM_LOBBY: string
  PLAYER_LIST_CHANGED: void
  'show-role': void
  [key: string]: unknown
}

export const EventBus = mitt<Events>()
