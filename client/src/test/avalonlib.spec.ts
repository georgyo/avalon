import { describe, it, expect } from 'vitest'
import { ROLES, getNumEvilForGameSize } from '../lib/avalonlib'

describe('avalonlib', () => {
  describe('ROLES', () => {
    it('should have 8 total roles defined', () => {
      expect(ROLES).toHaveLength(8)
    })

    it('should have required roles', () => {
      const roleNames = ROLES.map(r => r.name)
      expect(roleNames).toContain('MERLIN')
      expect(roleNames).toContain('PERCIVAL')
      expect(roleNames).toContain('LOYAL FOLLOWER')
      expect(roleNames).toContain('MORGANA')
      expect(roleNames).toContain('MORDRED')
      expect(roleNames).toContain('OBERON')
      expect(roleNames).toContain('ASSASSIN')
      expect(roleNames).toContain('EVIL MINION')
    })

    it('should have 3 good roles', () => {
      const goodRoles = ROLES.filter(r => r.team === 'good')
      expect(goodRoles).toHaveLength(3)
    })

    it('should have 5 evil roles', () => {
      const evilRoles = ROLES.filter(r => r.team === 'evil')
      expect(evilRoles).toHaveLength(5)
    })

    describe('MERLIN', () => {
      const merlin = ROLES.find(r => r.name === 'MERLIN')!

      it('should be on good team', () => {
        expect(merlin.team).toBe('good')
      })

      it('should see evil roles except Mordred', () => {
        expect(merlin.sees).toContain('MORGANA')
        expect(merlin.sees).toContain('OBERON')
        expect(merlin.sees).toContain('ASSASSIN')
        expect(merlin.sees).toContain('EVIL MINION')
        expect(merlin.sees).not.toContain('MORDRED')
      })

      it('should be selected and selectable', () => {
        expect(merlin.selected).toBe(true)
        expect(merlin.selectable).toBe(true)
      })
    })

    describe('PERCIVAL', () => {
      const percival = ROLES.find(r => r.name === 'PERCIVAL')!

      it('should be on good team', () => {
        expect(percival.team).toBe('good')
      })

      it('should see Merlin and Morgana', () => {
        expect(percival.sees).toContain('MERLIN')
        expect(percival.sees).toContain('MORGANA')
        expect(percival.sees).toHaveLength(2)
      })

      it('should be selected and selectable', () => {
        expect(percival.selected).toBe(true)
        expect(percival.selectable).toBe(true)
      })
    })

    describe('MORGANA', () => {
      const morgana = ROLES.find(r => r.name === 'MORGANA')!

      it('should be on evil team', () => {
        expect(morgana.team).toBe('evil')
      })

      it('should see other evil (except Oberon)', () => {
        expect(morgana.sees).toContain('MORDRED')
        expect(morgana.sees).toContain('ASSASSIN')
        expect(morgana.sees).toContain('EVIL MINION')
        expect(morgana.sees).not.toContain('OBERON')
      })

      it('should have assassination priority', () => {
        expect(morgana.assassinationPriority).toBe(2)
      })
    })

    describe('MORDRED', () => {
      const mordred = ROLES.find(r => r.name === 'MORDRED')!

      it('should be on evil team', () => {
        expect(mordred.team).toBe('evil')
      })

      it('should see other evil (except Oberon)', () => {
        expect(mordred.sees).toContain('MORGANA')
        expect(mordred.sees).toContain('ASSASSIN')
        expect(mordred.sees).toContain('EVIL MINION')
        expect(mordred.sees).not.toContain('OBERON')
      })

      it('should have assassination priority', () => {
        expect(mordred.assassinationPriority).toBe(3)
      })

      it('should not be selected by default', () => {
        expect(mordred.selected).toBe(false)
      })
    })

    describe('OBERON', () => {
      const oberon = ROLES.find(r => r.name === 'OBERON')!

      it('should be on evil team', () => {
        expect(oberon.team).toBe('evil')
      })

      it('should see nobody', () => {
        expect(oberon.sees).toHaveLength(0)
      })

      it('should have lowest assassination priority', () => {
        expect(oberon.assassinationPriority).toBe(1)
      })

      it('should not be selected by default', () => {
        expect(oberon.selected).toBe(false)
      })
    })

    describe('ASSASSIN', () => {
      const assassin = ROLES.find(r => r.name === 'ASSASSIN')!

      it('should be on evil team', () => {
        expect(assassin.team).toBe('evil')
      })

      it('should see other evil (except Oberon)', () => {
        expect(assassin.sees).toContain('MORGANA')
        expect(assassin.sees).toContain('MORDRED')
        expect(assassin.sees).toContain('EVIL MINION')
        expect(assassin.sees).not.toContain('OBERON')
      })

      it('should have highest assassination priority', () => {
        expect(assassin.assassinationPriority).toBe(10)
      })
    })

    describe('LOYAL FOLLOWER', () => {
      const loyalFollower = ROLES.find(r => r.name === 'LOYAL FOLLOWER')!

      it('should be on good team', () => {
        expect(loyalFollower.team).toBe('good')
      })

      it('should see nobody', () => {
        expect(loyalFollower.sees).toHaveLength(0)
      })

      it('should be a filler role', () => {
        expect(loyalFollower.filler).toBe(true)
      })

      it('should not be selectable', () => {
        expect(loyalFollower.selectable).toBe(false)
      })
    })

    describe('EVIL MINION', () => {
      const evilMinion = ROLES.find(r => r.name === 'EVIL MINION')!

      it('should be on evil team', () => {
        expect(evilMinion.team).toBe('evil')
      })

      it('should see other evil (except Oberon)', () => {
        expect(evilMinion.sees).toContain('MORGANA')
        expect(evilMinion.sees).toContain('MORDRED')
        expect(evilMinion.sees).toContain('ASSASSIN')
        expect(evilMinion.sees).toContain('EVIL MINION')
        expect(evilMinion.sees).not.toContain('OBERON')
      })

      it('should be a filler role', () => {
        expect(evilMinion.filler).toBe(true)
      })

      it('should not be selectable', () => {
        expect(evilMinion.selectable).toBe(false)
      })
    })
  })

  describe('getNumEvilForGameSize', () => {
    it('should return 2 evil for 5 players', () => {
      expect(getNumEvilForGameSize(5)).toBe(2)
    })

    it('should return 2 evil for 6 players', () => {
      expect(getNumEvilForGameSize(6)).toBe(2)
    })

    it('should return 3 evil for 7 players', () => {
      expect(getNumEvilForGameSize(7)).toBe(3)
    })

    it('should return 3 evil for 8 players', () => {
      expect(getNumEvilForGameSize(8)).toBe(3)
    })

    it('should return 3 evil for 9 players', () => {
      expect(getNumEvilForGameSize(9)).toBe(3)
    })

    it('should return 4 evil for 10 players', () => {
      expect(getNumEvilForGameSize(10)).toBe(4)
    })

    it('should return 0 for invalid player counts', () => {
      expect(getNumEvilForGameSize(0)).toBe(0)
      expect(getNumEvilForGameSize(3)).toBe(0)
      expect(getNumEvilForGameSize(4)).toBe(0)
      expect(getNumEvilForGameSize(11)).toBe(0)
      expect(getNumEvilForGameSize(100)).toBe(0)
    })

    it('should have correct good/evil ratio', () => {
      // 5 players: 3 good, 2 evil
      expect(5 - getNumEvilForGameSize(5)).toBe(3)
      // 6 players: 4 good, 2 evil
      expect(6 - getNumEvilForGameSize(6)).toBe(4)
      // 7 players: 4 good, 3 evil
      expect(7 - getNumEvilForGameSize(7)).toBe(4)
      // 10 players: 6 good, 4 evil
      expect(10 - getNumEvilForGameSize(10)).toBe(6)
    })
  })
})
