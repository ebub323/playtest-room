/**
 * Playtest Room collections.
 *
 * Two kinds of record scope use these schemas:
 *
 * - The app scope (`app:<APP_ID>`) holds `rooms`: one index row per playtest
 *   room, so a developer can list the rooms they own.
 * - Each room gets its own scope (`room:<roomId>`), a separate Durable Object
 *   holding that room's info, sessions, events, reports and issues. A busy
 *   playtest never contends with another room's writes, and deleting a room
 *   is deleting one object.
 *
 * Game telemetry (sessions, events, crash issues) is written only by the
 * ingest route (src/server/ingest.ts) through the RBAC-off tools API, so
 * clients get read access and no write access to those collections. Players
 * in the browser file reports through the `submitReport` server action
 * (src/actions/reports.ts), which sets source, player name and issue link
 * itself, so clients cannot create or edit report records directly.
 *
 * Access model: a room is shared by link. Anyone signed in who knows the
 * room id can read it (room ids are random, 128-bit). Owner-only operations
 * (rotate key, cluster, end playtest) go through server actions that check
 * `room_info.ownerId`.
 */

import type { CollectionSchema } from 'deepspace/schema'

const readOnly = { read: true, create: false, update: false, delete: false } as const
const nothing = { read: false, create: false, update: false, delete: false } as const

/** App scope: one index row per room, readable only by its creator. */
export const roomsSchema: CollectionSchema = {
  name: 'rooms',
  columns: [
    { name: 'name', storage: 'text', interpretation: 'plain' },
    { name: 'gameUrl', storage: 'text', interpretation: { kind: 'url' } },
    { name: 'ownerId', storage: 'text', interpretation: 'plain' },
    { name: 'status', storage: 'text', interpretation: { kind: 'select', options: ['live', 'ended'] } },
  ],
  ownerField: 'ownerId',
  permissions: {
    '*': nothing,
    viewer: nothing,
    member: { read: 'own', create: false, update: false, delete: false },
    admin: { read: true, create: false, update: false, delete: false },
  },
}

/** Room scope: a single record (id `info`) describing the room. */
export const roomInfoSchema: CollectionSchema = {
  name: 'room_info',
  columns: [
    { name: 'name', storage: 'text', interpretation: 'plain' },
    { name: 'gameUrl', storage: 'text', interpretation: { kind: 'url' } },
    { name: 'ownerId', storage: 'text', interpretation: 'plain' },
    { name: 'ownerName', storage: 'text', interpretation: 'plain' },
    { name: 'status', storage: 'text', interpretation: { kind: 'select', options: ['live', 'ended'] } },
    // Publishable write key, like a Sentry DSN: it ships inside game builds,
    // so it is not a secret. It only lets a caller append telemetry to this
    // room, and the ingest gate rate-limits and size-caps what it accepts.
    { name: 'ingestKey', storage: 'text', interpretation: 'plain' },
    { name: 'endedAt', storage: 'number', interpretation: 'plain' },
    { name: 'clusteredAt', storage: 'number', interpretation: 'plain' },
  ],
  permissions: { '*': nothing, viewer: readOnly, member: readOnly, admin: readOnly },
}

/** One row per play session, upserted by the ingest route. */
export const sessionsSchema: CollectionSchema = {
  name: 'sessions',
  columns: [
    { name: 'playerName', storage: 'text', interpretation: 'plain' },
    { name: 'buildVersion', storage: 'text', interpretation: 'plain' },
    { name: 'platform', storage: 'text', interpretation: 'plain' },
    { name: 'level', storage: 'text', interpretation: 'plain' },
    { name: 'status', storage: 'text', interpretation: { kind: 'select', options: ['live', 'ended'] } },
    { name: 'startedAt', storage: 'number', interpretation: 'plain' },
    { name: 'lastSeenAt', storage: 'number', interpretation: 'plain' },
    { name: 'endedAt', storage: 'number', interpretation: 'plain' },
    { name: 'fpsAvg', storage: 'number', interpretation: 'plain' },
    { name: 'fpsMin', storage: 'number', interpretation: 'plain' },
    { name: 'fpsSamples', storage: 'number', interpretation: 'plain' },
    { name: 'deaths', storage: 'number', interpretation: 'plain' },
    { name: 'errors', storage: 'number', interpretation: 'plain' },
    { name: 'eventCount', storage: 'number', interpretation: 'plain' },
  ],
  permissions: { '*': nothing, viewer: readOnly, member: readOnly, admin: readOnly },
}

/** Notable gameplay events: deaths, level changes, errors, custom markers. */
export const eventsSchema: CollectionSchema = {
  name: 'events',
  columns: [
    { name: 'sessionId', storage: 'text', interpretation: 'plain' },
    { name: 'playerName', storage: 'text', interpretation: 'plain' },
    { name: 'type', storage: 'text', interpretation: 'plain' },
    { name: 'level', storage: 'text', interpretation: 'plain' },
    { name: 'message', storage: 'text', interpretation: 'plain' },
    { name: 'position', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'issueId', storage: 'text', interpretation: 'plain' },
    { name: 'ts', storage: 'number', interpretation: 'plain' },
  ],
  permissions: { '*': nothing, viewer: readOnly, member: readOnly, admin: readOnly },
}

/** Player feedback, from the in-game F8 overlay or the web form. */
export const reportsSchema: CollectionSchema = {
  name: 'reports',
  columns: [
    { name: 'sessionId', storage: 'text', interpretation: 'plain' },
    { name: 'source', storage: 'text', interpretation: { kind: 'select', options: ['game', 'web'] } },
    { name: 'playerName', storage: 'text', interpretation: 'plain' },
    { name: 'category', storage: 'text', interpretation: { kind: 'select', options: ['bug', 'balance', 'ux', 'other'] } },
    { name: 'note', storage: 'text', interpretation: 'plain' },
    { name: 'level', storage: 'text', interpretation: 'plain' },
    { name: 'position', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'screenshotKey', storage: 'text', interpretation: 'plain' },
    { name: 'issueId', storage: 'text', interpretation: 'plain' },
  ],
  permissions: {
    '*': nothing,
    viewer: readOnly,
    // No direct create/update: a client could otherwise set source:'game',
    // another player's name, an issueId or a foreign screenshotKey.
    member: { read: true, create: false, update: false, delete: 'own' },
    admin: { read: true, create: false, update: false, delete: true },
  },
}

/**
 * Grouped problems. `crash` issues are grouped deterministically by stack
 * fingerprint at ingest time; `feedback` issues come from AI clustering of
 * player reports (src/actions/cluster.ts).
 */
export const issuesSchema: CollectionSchema = {
  name: 'issues',
  columns: [
    { name: 'kind', storage: 'text', interpretation: { kind: 'select', options: ['crash', 'feedback'] } },
    { name: 'title', storage: 'text', interpretation: 'plain' },
    { name: 'summary', storage: 'text', interpretation: 'plain' },
    { name: 'severity', storage: 'text', interpretation: { kind: 'select', options: ['low', 'medium', 'high', 'critical'] } },
    { name: 'status', storage: 'text', interpretation: { kind: 'select', options: ['open', 'fixed'] } },
    { name: 'count', storage: 'number', interpretation: 'plain' },
    { name: 'players', storage: 'number', interpretation: 'plain' },
    { name: 'sample', storage: 'text', interpretation: 'plain' },
    { name: 'firstSeenAt', storage: 'number', interpretation: 'plain' },
    { name: 'lastSeenAt', storage: 'number', interpretation: 'plain' },
  ],
  permissions: { '*': nothing, viewer: readOnly, member: readOnly, admin: readOnly },
}

export const playtestSchemas = [
  roomsSchema,
  roomInfoSchema,
  sessionsSchema,
  eventsSchema,
  reportsSchema,
  issuesSchema,
]
