import { describe, expect, it } from 'vitest'
import { aiSeverity } from './cluster'

describe('aiSeverity', () => {
  it('never lets the model pick critical', () => {
    expect(aiSeverity('critical')).toBe('high')
    expect(aiSeverity('low')).toBe('low')
    expect(aiSeverity('urgent!!')).toBe('medium')
  })
})
