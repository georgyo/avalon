import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AvalonApi } from '../avalon-api-rest'

// Mock firebase
vi.mock('firebase/compat/app', () => ({
  default: {
    auth: () => ({
      currentUser: {
        getIdToken: vi.fn(() => Promise.resolve('fake-token'))
      }
    })
  }
}))

// Mock axios
vi.mock('axios', () => ({
  default: {
    defaults: { baseURL: '' },
    post: vi.fn(() => Promise.resolve({ data: { success: true } }))
  }
}))

describe('AvalonApi', () => {
  let api: AvalonApi

  beforeEach(() => {
    api = new AvalonApi()
  })

  describe('constructor', () => {
    it('should initialize API', () => {
      expect(api).toBeInstanceOf(AvalonApi)
    })
  })

  describe('API methods structure', () => {
    it('should have login method', () => {
      expect(typeof api.login).toBe('function')
    })

    it('should have joinLobby method', () => {
      expect(typeof api.joinLobby).toBe('function')
    })

    it('should have createLobby method', () => {
      expect(typeof api.createLobby).toBe('function')
    })

    it('should have leaveLobby method', () => {
      expect(typeof api.leaveLobby).toBe('function')
    })

    it('should have kickPlayer method', () => {
      expect(typeof api.kickPlayer).toBe('function')
    })

    it('should have cancelGame method', () => {
      expect(typeof api.cancelGame).toBe('function')
    })

    it('should have voteTeam method', () => {
      expect(typeof api.voteTeam).toBe('function')
    })

    it('should have proposeTeam method', () => {
      expect(typeof api.proposeTeam).toBe('function')
    })

    it('should have startGame method', () => {
      expect(typeof api.startGame).toBe('function')
    })

    it('should have doMission method', () => {
      expect(typeof api.doMission).toBe('function')
    })

    it('should have assassinate method', () => {
      expect(typeof api.assassinate).toBe('function')
    })
  })

  describe('method signatures', () => {
    it('login should accept email parameter', () => {
      expect(api.login.length).toBe(1)
    })

    it('joinLobby should accept name and lobby parameters', () => {
      expect(api.joinLobby.length).toBe(2)
    })

    it('createLobby should accept name parameter', () => {
      expect(api.createLobby.length).toBe(1)
    })

    it('leaveLobby should accept lobby parameter', () => {
      expect(api.leaveLobby.length).toBe(1)
    })

    it('kickPlayer should accept lobby and name parameters', () => {
      expect(api.kickPlayer.length).toBe(2)
    })

    it('cancelGame should accept lobby and name parameters', () => {
      expect(api.cancelGame.length).toBe(2)
    })
  })
})
