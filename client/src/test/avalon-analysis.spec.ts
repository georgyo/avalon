import { describe, it, expect, beforeEach } from 'vitest'
import GameAnalysis from '../avalon-analysis'

describe('GameAnalysis', () => {
  const mockRoleMap = {
    'MERLIN': { team: 'good', name: 'MERLIN' },
    'PERCIVAL': { team: 'good', name: 'PERCIVAL' },
    'LOYAL FOLLOWER': { team: 'good', name: 'LOYAL FOLLOWER' },
    'MORGANA': { team: 'evil', name: 'MORGANA' },
    'ASSASSIN': { team: 'evil', name: 'ASSASSIN' },
    'MORDRED': { team: 'evil', name: 'MORDRED' },
  }

  describe('constructor', () => {
    it('should initialize with game data', () => {
      const mockGame = {
        outcome: {
          roles: [
            { name: 'Alice', role: 'MERLIN' },
            { name: 'Bob', role: 'ASSASSIN' },
            { name: 'Charlie', role: 'LOYAL FOLLOWER' },
          ]
        },
        missions: []
      }

      const analysis = new GameAnalysis(mockGame, mockRoleMap)

      expect(analysis.game).toBe(mockGame)
      expect(analysis.rolesByName).toEqual({
        'Alice': { name: 'Alice', role: 'MERLIN' },
        'Bob': { name: 'Bob', role: 'ASSASSIN' },
        'Charlie': { name: 'Charlie', role: 'LOYAL FOLLOWER' },
      })
    })

    it('should separate good and evil players', () => {
      const mockGame = {
        outcome: {
          roles: [
            { name: 'Alice', role: 'MERLIN' },
            { name: 'Bob', role: 'ASSASSIN' },
            { name: 'Charlie', role: 'PERCIVAL' },
            { name: 'Dave', role: 'MORGANA' },
          ]
        },
        missions: []
      }

      const analysis = new GameAnalysis(mockGame, mockRoleMap)

      expect(analysis.goodPlayers).toEqual(['Alice', 'Charlie'])
      expect(analysis.evilPlayers).toEqual(['Bob', 'Dave'])
    })

    it('should track evil players on mission teams', () => {
      const mockGame = {
        outcome: {
          roles: [
            { name: 'Alice', role: 'MERLIN' },
            { name: 'Bob', role: 'ASSASSIN' },
            { name: 'Charlie', role: 'PERCIVAL' },
          ]
        },
        missions: [
          {
            team: ['Alice', 'Bob', 'Charlie'],
            proposals: []
          }
        ]
      }

      const analysis = new GameAnalysis(mockGame, mockRoleMap)

      expect(analysis.missions[0].evilOnTeam).toEqual(['Bob'])
    })
  })

  describe('roleProposesRole', () => {
    it('should detect when a role proposes another role', () => {
      const mockGame = {
        outcome: {
          roles: [
            { name: 'Alice', role: 'MERLIN' },
            { name: 'Bob', role: 'ASSASSIN' },
          ]
        },
        missions: [
          {
            team: [],
            proposals: [
              {
                proposer: 'Alice',
                team: ['Alice', 'Bob'],
                votes: []
              }
            ]
          }
        ]
      }

      const analysis = new GameAnalysis(mockGame, mockRoleMap)

      expect(analysis.roleProposesRole('MERLIN', 'ASSASSIN')).toBe(true)
    })

    it('should return false when role does not propose another', () => {
      const mockGame = {
        outcome: {
          roles: [
            { name: 'Alice', role: 'MERLIN' },
            { name: 'Bob', role: 'ASSASSIN' },
            { name: 'Charlie', role: 'PERCIVAL' },
          ]
        },
        missions: [
          {
            team: [],
            proposals: [
              {
                proposer: 'Alice',
                team: ['Alice', 'Charlie'],
                votes: []
              }
            ]
          }
        ]
      }

      const analysis = new GameAnalysis(mockGame, mockRoleMap)

      expect(analysis.roleProposesRole('MERLIN', 'ASSASSIN')).toBe(false)
    })

    it('should return false for non-existent roles', () => {
      const mockGame = {
        outcome: {
          roles: [
            { name: 'Alice', role: 'MERLIN' },
          ]
        },
        missions: []
      }

      const analysis = new GameAnalysis(mockGame, mockRoleMap)

      expect(analysis.roleProposesRole('MERLIN', 'NONEXISTENT')).toBe(false)
      expect(analysis.roleProposesRole('NONEXISTENT', 'MERLIN')).toBe(false)
    })
  })

  describe('roleApprovesRole', () => {
    it('should detect when a role approves another role', () => {
      const mockGame = {
        outcome: {
          roles: [
            { name: 'Alice', role: 'MERLIN' },
            { name: 'Bob', role: 'ASSASSIN' },
            { name: 'Charlie', role: 'PERCIVAL' },
          ]
        },
        missions: [
          {
            team: [],
            proposals: [
              {
                proposer: 'Charlie',
                team: ['Alice', 'Bob'],
                votes: ['Alice']
              }
            ]
          }
        ]
      }

      const analysis = new GameAnalysis(mockGame, mockRoleMap)

      expect(analysis.roleApprovesRole('MERLIN', 'ASSASSIN')).toBe(true)
    })

    it('should return false for hammer (5th) proposals', () => {
      const mockGame = {
        outcome: {
          roles: [
            { name: 'Alice', role: 'MERLIN' },
            { name: 'Bob', role: 'ASSASSIN' },
            { name: 'Charlie', role: 'PERCIVAL' },
          ]
        },
        missions: [
          {
            team: [],
            proposals: [
              { proposer: 'Charlie', team: ['Charlie'], votes: [] },
              { proposer: 'Alice', team: ['Alice'], votes: [] },
              { proposer: 'Bob', team: ['Bob'], votes: [] },
              { proposer: 'Charlie', team: ['Charlie'], votes: [] },
              { // 5th proposal (hammer)
                proposer: 'Charlie',
                team: ['Bob'],
                votes: ['Alice']
              }
            ]
          }
        ]
      }

      const analysis = new GameAnalysis(mockGame, mockRoleMap)

      // Hammer approvals don't count
      expect(analysis.roleApprovesRole('MERLIN', 'ASSASSIN')).toBe(false)
    })

    it('should return false when role does not approve', () => {
      const mockGame = {
        outcome: {
          roles: [
            { name: 'Alice', role: 'MERLIN' },
            { name: 'Bob', role: 'ASSASSIN' },
          ]
        },
        missions: [
          {
            team: [],
            proposals: [
              {
                proposer: 'Charlie',
                team: ['Bob'],
                votes: ['Dave'] // Alice not in votes
              }
            ]
          }
        ]
      }

      const analysis = new GameAnalysis(mockGame, mockRoleMap)

      expect(analysis.roleApprovesRole('MERLIN', 'ASSASSIN')).toBe(false)
    })
  })

  describe('roleTrustsRole', () => {
    it('should return badge when role proposes another', () => {
      const mockGame = {
        outcome: {
          roles: [
            { name: 'Alice', role: 'MERLIN' },
            { name: 'Bob', role: 'ASSASSIN' },
          ]
        },
        missions: [
          {
            team: [],
            proposals: [
              {
                proposer: 'Alice',
                team: ['Bob'],
                votes: []
              }
            ]
          }
        ]
      }

      const analysis = new GameAnalysis(mockGame, mockRoleMap)
      const badge = analysis.roleTrustsRole('MERLIN', 'ASSASSIN', (msg: string) => ({ message: msg }))

      expect(badge).toBeTruthy()
      expect(badge.message).toBe('proposed a team')
    })

    it('should return badge when role approves another', () => {
      const mockGame = {
        outcome: {
          roles: [
            { name: 'Alice', role: 'MERLIN' },
            { name: 'Bob', role: 'ASSASSIN' },
          ]
        },
        missions: [
          {
            team: [],
            proposals: [
              {
                proposer: 'Charlie',
                team: ['Bob'],
                votes: ['Alice']
              }
            ]
          }
        ]
      }

      const analysis = new GameAnalysis(mockGame, mockRoleMap)
      const badge = analysis.roleTrustsRole('MERLIN', 'ASSASSIN', (msg: string) => ({ message: msg }))

      expect(badge).toBeTruthy()
      expect(badge.message).toBe('approved a team')
    })

    it('should return badge when role both proposes and approves', () => {
      const mockGame = {
        outcome: {
          roles: [
            { name: 'Alice', role: 'MERLIN' },
            { name: 'Bob', role: 'ASSASSIN' },
          ]
        },
        missions: [
          {
            team: [],
            proposals: [
              {
                proposer: 'Alice',
                team: ['Bob'],
                votes: ['Alice']
              }
            ]
          }
        ]
      }

      const analysis = new GameAnalysis(mockGame, mockRoleMap)
      const badge = analysis.roleTrustsRole('MERLIN', 'ASSASSIN', (msg: string) => ({ message: msg }))

      expect(badge).toBeTruthy()
      expect(badge.message).toBe('both proposed and approved teams')
    })

    it('should return false when there is no trust', () => {
      const mockGame = {
        outcome: {
          roles: [
            { name: 'Alice', role: 'MERLIN' },
            { name: 'Bob', role: 'ASSASSIN' },
          ]
        },
        missions: [
          {
            team: [],
            proposals: []
          }
        ]
      }

      const analysis = new GameAnalysis(mockGame, mockRoleMap)
      const badge = analysis.roleTrustsRole('MERLIN', 'ASSASSIN', (msg: string) => ({ message: msg }))

      expect(badge).toBe(false)
    })
  })
})
