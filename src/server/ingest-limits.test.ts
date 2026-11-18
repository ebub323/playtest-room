import { describe, expect, it } from 'vitest'
import { BucketMap, newBucket, take } from './ingest-limits'

describe('take', () => {
  it('spends the burst, then refills over time', () => {
    const cfg = { capacity: 3, refillPerSec: 1 }
    const b = newBucket(cfg, 0)
    expect([take(b, cfg, 0), take(b, cfg, 0), take(b, cfg, 0), take(b, cfg, 0)]).toEqual([true, true, true, false])
    expect(take(b, cfg, 999)).toBe(false)
    expect(take(b, cfg, 2000)).toBe(true)
  })

  it('never refills past capacity or backwards in time', () => {
    const cfg = { capacity: 2, refillPerSec: 10 }
    const b = newBucket(cfg, 1000)
    take(b, cfg, 1_000_000)
    expect(b.tokens).toBe(1)
    take(b, cfg, 0) // clock went backwards: no refill, still spends
    expect(b.tokens).toBe(0)
  })
})

describe('BucketMap', () => {
  it('limits each key on its own', () => {
    const m = new BucketMap({ capacity: 1, refillPerSec: 0 }, 10)
    expect(m.take('a', 0)).toBe(true)
    expect(m.take('a', 0)).toBe(false)
    expect(m.take('b', 0)).toBe(true)
  })

  it('stays bounded and evicts the least recently used key', () => {
    const m = new BucketMap({ capacity: 1, refillPerSec: 0 }, 2)
    m.take('a', 0)
    m.take('b', 0)
    m.take('a', 0) // touch a: b is now oldest
    m.take('c', 0) // evicts b
    expect(m.size).toBe(2)
    expect(m.take('a', 0)).toBe(false) // a kept its drained bucket
    expect(m.take('b', 0)).toBe(true) // b came back fresh
  })
})
