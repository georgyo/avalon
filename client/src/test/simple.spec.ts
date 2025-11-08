import { describe, it, expect } from 'vitest'

describe('Simple Test', () => {
  it('should pass', () => {
    expect(1 + 1).toBe(2)
  })

  it('should do basic math', () => {
    expect(2 * 3).toBe(6)
  })
})
