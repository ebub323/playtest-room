import { describe, expect, it } from 'vitest'
import { validateGameUrl } from './game-url'

describe('validateGameUrl', () => {
  it('accepts https hosts and local http', () => {
    expect(validateGameUrl('https://user.itch.io/game')).toBe('https://user.itch.io/game')
    expect(validateGameUrl('https://user.github.io/build/index.html')).toBe('https://user.github.io/build/index.html')
    expect(validateGameUrl('http://localhost:8000/')).toBe('http://localhost:8000/')
  })

  it('rejects non-https, junk and credentials in the URL', () => {
    expect(validateGameUrl('http://example.com/')).toBeNull()
    expect(validateGameUrl('javascript:alert(1)')).toBeNull()
    expect(validateGameUrl('not a url')).toBeNull()
    expect(validateGameUrl(42)).toBeNull()
    expect(validateGameUrl('https://a:b@example.com/')).toBeNull()
  })

  it('rejects this app and any *.app.space host', () => {
    expect(validateGameUrl('https://playtest-room.app.space/r/x')).toBeNull()
    expect(validateGameUrl('https://other-app.app.space/')).toBeNull()
    expect(validateGameUrl('https://APP.SPACE./')).toBeNull()
    expect(validateGameUrl('https://games.example.com/', 'games.example.com')).toBeNull()
    expect(validateGameUrl('https://games.example.com/', 'example.com:443')).toBe('https://games.example.com/')
    expect(validateGameUrl('https://notapp.space/')).toBe('https://notapp.space/')
  })
})
