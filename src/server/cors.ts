import type { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppContext } from '../../worker.js'

/**
 * CORS for /api/*: the app's own pages call /api same-origin, which needs no
 * CORS, so only this origin is ever echoed back. /api/ingest/* is skipped:
 * hosted game builds post from any origin, and src/server/ingest.ts
 * registers its own POST-only, credential-free policy for it.
 */
export function registerApiCors(app: Hono<AppContext>): void {
  const ownOriginCors = cors({ origin: (origin, c) => (origin === new URL(c.req.url).origin ? origin : null) })
  app.use('/api/*', async (c, next) => {
    if (new URL(c.req.url).pathname.startsWith('/api/ingest/')) return next()
    return ownOriginCors(c, next)
  })
}
