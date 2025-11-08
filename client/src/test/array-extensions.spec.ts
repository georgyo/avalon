import { describe, it, expect } from 'vitest'

// Extend Array prototype for tests (as done in the app)
declare global {
  interface Array<T> {
    joinWithAnd(): string
    shuffle(): T[]
  }
}

Array.prototype.joinWithAnd = function() {
  if (this.length == 0) {
    return '';
  } else if (this.length == 1) {
    return this[0];
  } else if (this.length == 2) {
    return this[0] + ' and ' + this[1];
  } else {
    return this.slice(0, this.length - 1).join(', ') + ', and ' + this[this.length - 1];
  }
}

Array.prototype.shuffle = function() {
  const array = [...this]
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]]
  }
  return array
}

describe('Array Extensions', () => {
  describe('joinWithAnd', () => {
    it('should return empty string for empty array', () => {
      const arr: string[] = []
      expect(arr.joinWithAnd()).toBe('')
    })

    it('should return single element for array with one item', () => {
      const arr = ['Alice']
      expect(arr.joinWithAnd()).toBe('Alice')
    })

    it('should join two elements with "and"', () => {
      const arr = ['Alice', 'Bob']
      expect(arr.joinWithAnd()).toBe('Alice and Bob')
    })

    it('should join three elements with commas and "and"', () => {
      const arr = ['Alice', 'Bob', 'Charlie']
      expect(arr.joinWithAnd()).toBe('Alice, Bob, and Charlie')
    })

    it('should join four or more elements with commas and "and"', () => {
      const arr = ['Alice', 'Bob', 'Charlie', 'Dave']
      expect(arr.joinWithAnd()).toBe('Alice, Bob, Charlie, and Dave')
    })

    it('should work with numbers', () => {
      const arr = [1, 2, 3]
      expect(arr.joinWithAnd()).toBe('1, 2, and 3')
    })

    it('should work with mixed types', () => {
      const arr = ['Player1', 'Player2', 'Player3', 'Player4', 'Player5']
      expect(arr.joinWithAnd()).toBe('Player1, Player2, Player3, Player4, and Player5')
    })
  })

  describe('shuffle', () => {
    it('should return array with same length', () => {
      const arr = [1, 2, 3, 4, 5]
      const shuffled = arr.shuffle()
      expect(shuffled).toHaveLength(arr.length)
    })

    it('should contain same elements', () => {
      const arr = [1, 2, 3, 4, 5]
      const shuffled = arr.shuffle()

      expect(shuffled).toContain(1)
      expect(shuffled).toContain(2)
      expect(shuffled).toContain(3)
      expect(shuffled).toContain(4)
      expect(shuffled).toContain(5)
    })

    it('should not modify original array', () => {
      const arr = [1, 2, 3, 4, 5]
      const original = [...arr]
      arr.shuffle()
      expect(arr).toEqual(original)
    })

    it('should work with empty array', () => {
      const arr: number[] = []
      const shuffled = arr.shuffle()
      expect(shuffled).toEqual([])
    })

    it('should work with single element', () => {
      const arr = ['Alice']
      const shuffled = arr.shuffle()
      expect(shuffled).toEqual(['Alice'])
    })

    it('should work with strings', () => {
      const arr = ['Alice', 'Bob', 'Charlie']
      const shuffled = arr.shuffle()

      expect(shuffled).toHaveLength(3)
      expect(shuffled).toContain('Alice')
      expect(shuffled).toContain('Bob')
      expect(shuffled).toContain('Charlie')
    })

    it('should eventually produce different order', () => {
      const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
      let foundDifferent = false

      // Try shuffling multiple times to find a different order
      for (let i = 0; i < 10; i++) {
        const shuffled = arr.shuffle()
        if (JSON.stringify(shuffled) !== JSON.stringify(arr)) {
          foundDifferent = true
          break
        }
      }

      expect(foundDifferent).toBe(true)
    })
  })
})
