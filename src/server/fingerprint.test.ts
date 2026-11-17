import { describe, expect, it } from 'vitest'
import { crashFingerprint } from './fingerprint'

const stack = (line: number, method = 'Attack') =>
  `NullReferenceException\n  at Enemy.${method} (Enemy.cs:${line})\n  at Enemy.Update (Enemy.cs:41)\n  at UnityEngine.Loop ()`

describe('crashFingerprint', () => {
  it('groups the same crash when only numbers or quoted values differ', async () => {
    const a = await crashFingerprint('Index 3 out of range for "Wave_2"', stack(88))
    const b = await crashFingerprint('Index 7 out of range for "Wave_5"', stack(91))
    expect(a).toBe(b)
  })

  it('separates crashes in different methods', async () => {
    const a = await crashFingerprint('NullReferenceException', stack(88, 'Attack'))
    const b = await crashFingerprint('NullReferenceException', stack(88, 'Die'))
    expect(a).not.toBe(b)
  })

  it('only looks at the first three frames', async () => {
    const a = await crashFingerprint('Boom', stack(1) + '\n  at Deep.Caller1 ()')
    const b = await crashFingerprint('Boom', stack(1) + '\n  at Deep.Caller2 ()')
    expect(a).toBe(b)
  })

  it('is a 16-char hex id', async () => {
    expect(await crashFingerprint('x')).toMatch(/^[0-9a-f]{16}$/)
  })
})
