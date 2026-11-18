import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppContext } from '../../worker'
import { registerApiCors } from './cors'
import { registerIngestRoutes } from './ingest'

// Same order as worker.ts: API CORS first, ingest routes after.
function app() {
  const a = new Hono<AppContext>()
  registerApiCors(a)
  registerIngestRoutes(a)
  a.post('/api/actions/:name', (c) => c.json({ ok: true }))
  return a
}

function preflight(path: string, origin: string) {
  return app().request(`https://playtest-room.app.space${path}`, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  })
}

describe('API CORS', () => {
  it('answers only the app’s own origin on /api/*', async () => {
    const own = await preflight('/api/actions/createRoom', 'https://playtest-room.app.space')
    expect(own.headers.get('Access-Control-Allow-Origin')).toBe('https://playtest-room.app.space')
    const other = await preflight('/api/actions/createRoom', 'https://evil.example')
    expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('keeps ingest open to any origin, POST only, no credentials', async () => {
    const res = await preflight('/api/ingest/0123456789abcdef0123456789abcdef', 'https://user.itch.io')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('POST,OPTIONS')
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('X-Playtest-Key')
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull()
  })
})
