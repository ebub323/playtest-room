import { describe, expect, it } from 'vitest'
import { parseWebReport } from './reports'

const roomId = 'a'.repeat(32)

describe('parseWebReport', () => {
  it('keeps only the fields a player may choose', () => {
    expect(
      parseWebReport({ roomId, note: '  fell through floor ', category: 'ux', source: 'game', issueId: 'crash-x', playerName: 'Dev' }),
    ).toEqual({ roomId, note: 'fell through floor', category: 'ux', screenshotKey: '' })
  })

  it('defaults an unknown category to bug', () => {
    expect(parseWebReport({ roomId, note: 'x', category: 'critical' })).toMatchObject({ category: 'bug' })
  })

  it('rejects bad rooms and empty or huge notes', () => {
    expect(parseWebReport({ roomId: 'nope', note: 'x' })).toHaveProperty('error')
    expect(parseWebReport({ roomId, note: '   ' })).toHaveProperty('error')
    expect(parseWebReport({ roomId, note: 'x'.repeat(2001) })).toHaveProperty('error')
  })

  it('accepts only screenshot keys under this room', () => {
    const own = `rooms/${roomId}/123e4567-e89b-12d3-a456-426614174000.jpg`
    expect(parseWebReport({ roomId, note: 'x', screenshotKey: own })).toMatchObject({ screenshotKey: own })
    for (const bad of [
      `rooms/${'b'.repeat(32)}/123e4567-e89b-12d3-a456-426614174000.jpg`,
      `rooms/${roomId}/../other.jpg`,
      `users/secret.jpg`,
      42,
    ]) {
      expect(parseWebReport({ roomId, note: 'x', screenshotKey: bad })).toHaveProperty('error')
    }
  })
})
