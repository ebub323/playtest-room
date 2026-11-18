/**
 * Telemetry ingest for game builds.
 *
 *   POST /api/ingest/:roomId
 *   X-Playtest-Key: pk_...
 *   { sessionId, playerName?, buildVersion?, platform?, events: [...], report? }
 *
 * A game build has no DeepSpace session, so this route cannot use the
 * caller-JWT path that server actions use. It authenticates with the room's
 * publishable ingest key instead and hands the request to that room's
 * IngestGate Durable Object, which:
 *
 *  1. applies a per-client-IP token bucket, so rotating sessionIds or keys
 *     from one address cannot get around the limits below,
 *  2. checks the key against the room (cached for 30s, invalidated on rotate)
 *     BEFORE charging the room's budget; failed keys are charged to their own
 *     small bucket, so someone who knows a room id but not its key cannot
 *     starve the real testers,
 *  3. applies token-bucket rate limits per room and per session,
 *  4. serializes the room's writes, so per-session aggregates and per-crash
 *     counts are read-modify-write safe without trusting the client,
 *  5. writes sessions/events/issues/reports into the room's record scope
 *     through the RBAC-off tools API, where every connected dashboard sees
 *     them live.
 *
 * Why a Durable Object and not the worker: rate limits and counters need one
 * consistent place per room. A Worker isolate's memory is per-instance, and
 * the platform offers no rate-limit binding, so a per-room object is the
 * natural owner of that state.
 */

import type { Hono } from 'hono'
import { cors } from 'hono/cors'
import { z } from 'zod'
import { appFiles } from 'deepspace/worker'
import type { ActionTools } from 'deepspace/worker'
import type { AppContext, Env } from '../../worker.js'
import { createActionTools } from './action-routes.js'
import { crashFingerprint } from './fingerprint.js'
import { BucketMap, newBucket, take, type Bucket } from './ingest-limits.js'

const ROOM_ID_RE = /^[a-f0-9]{32}$/
const MAX_BODY_BYTES = 2_500_000
const MAX_SCREENSHOT_BYTES = 1_500_000
const MAX_EVENT_ROWS_PER_SESSION = 1_500
const KEY_CACHE_MS = 30_000
const SESSION_IDLE_MS = 3 * 60_000

// Token buckets: a room sustains 5 req/s (burst 60); one session 1 req/s
// (burst 10). The Unity reporter batches every 2s, so a normal session uses
// about half its budget.
const ROOM_BUCKET = { capacity: 60, refillPerSec: 5 }
const SESSION_BUCKET = { capacity: 10, refillPerSec: 1 }
const MAX_TRACKED_SESSIONS = 500
// One client address: room for several testers behind one NAT (a game jam,
// an office) at ~0.5 req/s each, far below the room's own budget.
const IP_BUCKET = { capacity: 30, refillPerSec: 3 }
const MAX_TRACKED_IPS = 1_000
// Requests with a wrong or missing key. Kept small and separate from the room
// bucket: a flood of bad keys only ever slows down other bad keys.
const FAILED_KEY_BUCKET = { capacity: 10, refillPerSec: 0.5 }

const vec3 = z.object({ x: z.number(), y: z.number(), z: z.number() }).optional()
const shortText = (max: number) => z.string().max(max).optional()

const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session_start'), level: shortText(80), t: z.number().optional() }),
  z.object({ type: z.literal('session_end'), level: shortText(80), t: z.number().optional() }),
  z.object({
    type: z.literal('heartbeat'),
    level: shortText(80),
    fpsAvg: z.number().min(0).max(1000),
    fpsMin: z.number().min(0).max(1000),
    t: z.number().optional(),
  }),
  z.object({ type: z.literal('death'), level: shortText(80), position: vec3, message: shortText(200), t: z.number().optional() }),
  z.object({ type: z.literal('level'), level: z.string().max(80), t: z.number().optional() }),
  z.object({
    type: z.literal('error'),
    level: shortText(80),
    message: z.string().max(1000),
    stack: shortText(4000),
    t: z.number().optional(),
  }),
  z.object({ type: z.literal('custom'), level: shortText(80), message: z.string().max(200), position: vec3, t: z.number().optional() }),
])

const payloadSchema = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  playerName: shortText(40),
  buildVersion: shortText(40),
  platform: shortText(40),
  events: z.array(eventSchema).max(50).default([]),
  report: z
    .object({
      note: z.string().min(1).max(2000),
      category: z.enum(['bug', 'balance', 'ux', 'other']).default('bug'),
      level: shortText(80),
      position: vec3,
      screenshotJpegBase64: z.string().max(Math.ceil((MAX_SCREENSHOT_BYTES * 4) / 3) + 4).optional(),
    })
    .optional(),
})

type Payload = z.infer<typeof payloadSchema>
type GameEvent = z.infer<typeof eventSchema>

type SessionAgg = {
  playerName: string
  startedAt: number
  lastSeenAt: number
  fpsSum: number
  fpsSamples: number
  fpsMin: number
  deaths: number
  errors: number
  eventCount: number
  level: string
  ended: boolean
}

type CrashAgg = { count: number; players: string[]; firstSeenAt: number }

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

export class IngestGate implements DurableObject {
  private roomBucket: Bucket = newBucket(ROOM_BUCKET, Date.now())
  private failedKeyBucket: Bucket = newBucket(FAILED_KEY_BUCKET, Date.now())
  private sessionBuckets = new BucketMap(SESSION_BUCKET, MAX_TRACKED_SESSIONS)
  private ipBuckets = new BucketMap(IP_BUCKET, MAX_TRACKED_IPS)
  // `missing` rooms are cached too, so probing unknown room ids costs no
  // record-room reads beyond one per cache window.
  private keyCache: { key: string; ownerId: string; status: string; missing: boolean; at: number } | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const roomId = url.searchParams.get('room') ?? ''
    if (!ROOM_ID_RE.test(roomId)) return json({ error: 'Invalid room' }, 400)

    if (url.pathname === '/invalidate') {
      this.keyCache = null
      return json({ ok: true })
    }
    if (url.pathname === '/close-idle') {
      return this.serialize(() => this.closeIdleSessions(roomId))
    }

    const now = Date.now()
    // Set by the worker from CF-Connecting-IP; the gate is not reachable
    // from outside, so callers cannot supply their own value.
    const clientIp = request.headers.get('X-Client-IP') || 'unknown'
    if (!this.ipBuckets.take(clientIp, now)) {
      return json({ error: 'Too many requests' }, 429, { 'Retry-After': '5' })
    }

    // Key first, from the cache: a wrong key must never spend the room's budget.
    const tools = createActionTools(this.env, this.env.OWNER_USER_ID, '', `room:${roomId}`)
    const auth = await this.checkKey(tools, request.headers.get('X-Playtest-Key') ?? '')
    if (auth === 'missing' || auth === 'bad-key') {
      if (!take(this.failedKeyBucket, FAILED_KEY_BUCKET, now)) {
        return json({ error: 'Too many failed attempts' }, 429, { 'Retry-After': '10' })
      }
      return auth === 'missing' ? json({ error: 'Room not found' }, 404) : json({ error: 'Invalid ingest key' }, 401)
    }
    if (auth.status === 'ended') return json({ error: 'This playtest has ended' }, 410)

    if (!take(this.roomBucket, ROOM_BUCKET, now)) {
      return json({ error: 'Room rate limit exceeded' }, 429, { 'Retry-After': '2' })
    }

    let payload: Payload
    try {
      const parsed = payloadSchema.safeParse(await request.json())
      if (!parsed.success) {
        return json({ error: 'Invalid payload', issues: parsed.error.issues.slice(0, 5) }, 400)
      }
      payload = parsed.data
    } catch {
      return json({ error: 'Body must be JSON' }, 400)
    }

    if (!this.sessionBuckets.take(payload.sessionId, now)) {
      return json({ error: 'Session rate limit exceeded' }, 429, { 'Retry-After': '2' })
    }

    return this.serialize(() => this.ingest(roomId, tools, auth.ownerId, payload))
  }

  /** Run room writes one at a time: aggregates below are read-modify-write. */
  private serialize(fn: () => Promise<Response>): Promise<Response> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  private async checkKey(
    tools: ActionTools,
    presented: string,
  ): Promise<'missing' | 'bad-key' | { ownerId: string; status: string }> {
    const now = Date.now()
    if (!this.keyCache || now - this.keyCache.at > KEY_CACHE_MS) {
      const r = await tools.get('room_info', 'info')
      const record = r.success ? (r.data as { record?: { data: Record<string, unknown> } }).record : undefined
      this.keyCache = record
        ? {
            key: String(record.data.ingestKey ?? ''),
            ownerId: String(record.data.ownerId ?? ''),
            status: String(record.data.status ?? 'live'),
            missing: false,
            at: now,
          }
        : { key: '', ownerId: '', status: '', missing: true, at: now }
    }
    if (this.keyCache.missing) return 'missing'
    if (!presented || !timingSafeEqual(presented, this.keyCache.key)) return 'bad-key'
    return { ownerId: this.keyCache.ownerId, status: this.keyCache.status }
  }

  private async ingest(roomId: string, tools: ActionTools, ownerId: string, p: Payload): Promise<Response> {
    const now = Date.now()
    const sessionKey = `session:${p.sessionId}`
    const agg: SessionAgg = (await this.state.storage.get<SessionAgg>(sessionKey)) ?? {
      playerName: p.playerName || 'Anonymous player',
      startedAt: now,
      lastSeenAt: now,
      fpsSum: 0,
      fpsSamples: 0,
      fpsMin: 0,
      deaths: 0,
      errors: 0,
      eventCount: 0,
      level: '',
      ended: false,
    }
    const isNew = agg.eventCount === 0 && agg.fpsSamples === 0
    if (p.playerName) agg.playerName = p.playerName
    agg.lastSeenAt = now
    agg.ended = false

    const rows: Record<string, unknown>[] = []
    const crashes: { ev: Extract<GameEvent, { type: 'error' }>; fp: string }[] = []

    for (const ev of p.events) {
      if (ev.level) agg.level = ev.level
      switch (ev.type) {
        case 'heartbeat':
          agg.fpsSum += ev.fpsAvg
          agg.fpsSamples += 1
          agg.fpsMin = agg.fpsMin === 0 ? ev.fpsMin : Math.min(agg.fpsMin, ev.fpsMin)
          continue // aggregated into the session row, not stored per sample
        case 'session_end':
          agg.ended = true
          break
        case 'death':
          agg.deaths += 1
          break
        case 'error':
          agg.errors += 1
          crashes.push({ ev, fp: await crashFingerprint(ev.message, ev.stack) })
          break
      }
      agg.eventCount += 1
      if (agg.eventCount > MAX_EVENT_ROWS_PER_SESSION && ev.type !== 'error') continue
      rows.push({
        sessionId: p.sessionId,
        playerName: agg.playerName,
        type: ev.type,
        level: ev.level ?? agg.level,
        message:
          ev.type === 'error' || ev.type === 'custom' || ev.type === 'death' ? (ev.message ?? '') : ev.type === 'level' ? ev.level : '',
        position: 'position' in ev ? (ev.position ?? null) : null,
        issueId: '',
        ts: now,
      })
    }

    // Crash grouping: counts live in this object's storage so concurrent
    // reports of the same crash never lose an increment.
    for (const { ev, fp } of crashes) {
      const issueId = `crash-${fp}`
      const crashKey = `crash:${fp}`
      const crash: CrashAgg = (await this.state.storage.get<CrashAgg>(crashKey)) ?? {
        count: 0,
        players: [],
        firstSeenAt: now,
      }
      crash.count += 1
      if (!crash.players.includes(p.sessionId) && crash.players.length < 200) crash.players.push(p.sessionId)
      await this.state.storage.put(crashKey, crash)
      const row = rows.find((r) => r.type === 'error' && r.message === ev.message && r.issueId === '')
      if (row) row.issueId = issueId
      await tools.create(
        'issues',
        {
          kind: 'crash',
          severity: crash.players.length >= 3 ? 'critical' : 'high',
          // Title and stack come from the first occurrence and stay put.
          ...(crash.count === 1
            ? {
                status: 'open',
                firstSeenAt: now,
                title: (ev.message.split('\n')[0] ?? 'Error').slice(0, 140),
                summary: '',
                sample: (ev.stack ?? '').split('\n').slice(0, 6).join('\n'),
              }
            : {}),
          count: crash.count,
          players: crash.players.length,
          lastSeenAt: now,
        },
        issueId,
      )
    }

    await this.state.storage.put(sessionKey, agg)
    await tools.create(
      'sessions',
      {
        playerName: agg.playerName,
        ...(isNew ? { buildVersion: p.buildVersion ?? '', platform: p.platform ?? '', startedAt: agg.startedAt } : {}),
        level: agg.level,
        status: agg.ended ? 'ended' : 'live',
        lastSeenAt: now,
        ...(agg.ended ? { endedAt: now } : {}),
        fpsAvg: agg.fpsSamples ? Math.round((agg.fpsSum / agg.fpsSamples) * 10) / 10 : 0,
        fpsMin: Math.round(agg.fpsMin),
        fpsSamples: agg.fpsSamples,
        deaths: agg.deaths,
        errors: agg.errors,
        eventCount: agg.eventCount,
      },
      p.sessionId,
    )
    for (const row of rows) await tools.create('events', row)

    let reportId: string | undefined
    if (p.report) {
      let screenshotKey = ''
      if (p.report.screenshotJpegBase64) {
        const bytes = decodeBase64(p.report.screenshotJpegBase64)
        if (bytes && bytes.byteLength <= MAX_SCREENSHOT_BYTES && isJpeg(bytes)) {
          try {
            // 'app' scope is publicly readable by key; keys are random and
            // namespaced per room. Room data itself is link-shared the same way.
            const file = await appFiles(this.env, { scope: 'app', userId: ownerId }).upload(
              new Blob([bytes], { type: 'image/jpeg' }),
              { key: `rooms/${roomId}/${crypto.randomUUID()}.jpg`, name: 'screenshot.jpg' },
            )
            screenshotKey = file.key
          } catch (err) {
            console.warn(`[ingest] screenshot upload failed room=${roomId}: ${String(err)}`)
          }
        }
      }
      const r = await tools.create('reports', {
        sessionId: p.sessionId,
        source: 'game',
        playerName: agg.playerName,
        category: p.report.category,
        note: p.report.note,
        level: p.report.level ?? agg.level,
        position: p.report.position ?? null,
        screenshotKey,
        issueId: '',
      })
      if (r.success) reportId = (r.data as { recordId: string }).recordId
    }

    return json({ ok: true, accepted: p.events.length, reportId })
  }

  /** Called by the cron task: mark sessions with no traffic as ended. */
  private async closeIdleSessions(roomId: string): Promise<Response> {
    const now = Date.now()
    const tools = createActionTools(this.env, this.env.OWNER_USER_ID, '', `room:${roomId}`)
    const stored = await this.state.storage.list<SessionAgg>({ prefix: 'session:' })
    let closed = 0
    for (const [key, agg] of stored) {
      if (agg.ended || now - agg.lastSeenAt < SESSION_IDLE_MS) continue
      agg.ended = true
      await this.state.storage.put(key, agg)
      await tools.update('sessions', key.slice('session:'.length), { status: 'ended', endedAt: agg.lastSeenAt })
      closed += 1
    }
    return json({ ok: true, closed })
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function decodeBase64(s: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(s.replace(/^data:image\/jpeg;base64,/, ''))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

function isJpeg(b: Uint8Array): boolean {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
}

export function ingestGate(env: Env, roomId: string): DurableObjectStub {
  return env.INGEST_GATES.get(env.INGEST_GATES.idFromName(`gate:${roomId}`))
}

export function registerIngestRoutes(app: Hono<AppContext>): void {
  // Game builds post from wherever they are hosted (itch.io, GitHub Pages,
  // localhost), so this route answers any origin. It carries no cookies or
  // user tokens; the ingest key is the only credential.
  app.use(
    '/api/ingest/*',
    cors({ origin: '*', allowMethods: ['POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'X-Playtest-Key'], maxAge: 86400 }),
  )

  app.post('/api/ingest/:roomId', async (c) => {
    const roomId = c.req.param('roomId')
    if (!ROOM_ID_RE.test(roomId)) return c.json({ error: 'Invalid room' }, 400)
    const declared = Number(c.req.header('Content-Length') ?? '0')
    if (declared > MAX_BODY_BYTES) return c.json({ error: 'Payload too large' }, 413)
    const body = await c.req.arrayBuffer()
    if (body.byteLength > MAX_BODY_BYTES) return c.json({ error: 'Payload too large' }, 413)

    const res = await ingestGate(c.env, roomId).fetch(
      new Request(`https://gate/ingest?room=${roomId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Playtest-Key': c.req.header('X-Playtest-Key') ?? '',
          // Cloudflare sets this and strips any client-sent copy.
          'X-Client-IP': c.req.header('CF-Connecting-IP') ?? '',
        },
        body,
      }),
    )
    return new Response(res.body, { status: res.status, headers: res.headers })
  })
}
