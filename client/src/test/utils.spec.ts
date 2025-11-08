import { describe, it, expect } from 'vitest'

// Example utility function tests
describe('Utility Functions', () => {
  it('should perform basic math', () => {
    expect(1 + 1).toBe(2)
    expect(2 * 3).toBe(6)
    expect(10 / 2).toBe(5)
  })

  it('should handle strings', () => {
    expect('hello'.toUpperCase()).toBe('HELLO')
    expect('world'.length).toBe(5)
  })

  it('should work with arrays', () => {
    const arr = [1, 2, 3]
    expect(arr.length).toBe(3)
    expect(arr).toContain(2)
  })
})

// Add your own utility function tests here
// Example:
// import { yourFunction } from '../lib/utils'
//
// describe('yourFunction', () => {
//   it('should do something', () => {
//     expect(yourFunction()).toBe(expectedResult)
//   })
// })
