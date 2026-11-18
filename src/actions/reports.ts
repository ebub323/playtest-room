/**
 * Web reports: the "Report something" form on the room page.
 *
 * Players cannot create report records directly (reportsSchema sets member
 * create to false). Every field a player could forge is set here instead:
 * source is always 'web', issueId starts empty (only AI grouping links
 * reports to issues), the player name comes from the caller's verified
 * sign-in token, a screenshot key must name a file under this room, and the
 * room must still be live.
 */

import { isAnonymousUserId, resolveAppRole, verifyJwt } from 'deepspace/worker'
import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { readRoomInfo, ROOM_ID_RE, roomTools } from './room-access.js'

const CATEGORIES = ['bug', 'balance', 'ux', 'other'] as const
const MAX_NOTE = 2000

export type WebReportInput = { roomId: string; note: string; category: (typeof CATEGORIES)[number]; screenshotKey: string }

/** Validate the client-supplied fields. Everything else is server-set. */
export function parseWebReport(params: Record<string, unknown>): WebReportInput | { error: string } {
  const roomId = params.roomId
  if (typeof roomId !== 'string' || !ROOM_ID_RE.test(roomId)) return { error: 'Invalid room id' }
  const note = typeof params.note === 'string' ? params.note.trim() : ''
  if (!note) return { error: 'Write what happened' }
  if (note.length > MAX_NOTE) return { error: `Keep it under ${MAX_NOTE} characters` }
  const category = CATEGORIES.includes(params.category as WebReportInput['category'])
    ? (params.category as WebReportInput['category'])
    : 'bug'
  const screenshotKey = params.screenshotKey ?? ''
  if (typeof screenshotKey !== 'string') return { error: 'Invalid screenshot' }
  // Same shape the ingest route writes: rooms/<roomId>/<uuid>.jpg
  if (screenshotKey && !new RegExp(`^rooms/${roomId}/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\\.jpg$`).test(screenshotKey)) {
    return { error: 'That screenshot does not belong to this room' }
  }
  return { roomId, note, category, screenshotKey }
}

export const submitReport: ActionHandler<Env> = async ({ userId, params, env, callerJwt }) => {
  const input = parseWebReport(params)
  if ('error' in input) return { success: false, error: input.error }

  // Server actions run RBAC-off, so the role check the schema used to do for
  // `member: create` happens here.
  if (isAnonymousUserId(userId)) return { success: false, error: 'Sign in to send a report' }
  const role = await resolveAppRole(env, userId)
  if (role !== 'member' && role !== 'admin') return { success: false, error: 'Sign in to send a report' }

  const tools = roomTools(env, userId, callerJwt, input.roomId)
  const info = await readRoomInfo(tools)
  if (!info) return { success: false, error: 'Room not found' }
  if (info.status !== 'live') return { success: false, error: 'This playtest has ended' }

  const verified = await verifyJwt({ publicKey: env.AUTH_JWT_PUBLIC_KEY, issuer: env.AUTH_JWT_ISSUER }, callerJwt)
  const playerName = String(verified.result?.claims.name || 'Tester').slice(0, 40)

  const created = await tools.create('reports', {
    sessionId: '',
    source: 'web',
    playerName,
    category: input.category,
    note: input.note,
    level: '',
    position: null,
    screenshotKey: input.screenshotKey,
    issueId: '',
  })
  if (!created.success) return created
  return { success: true, data: { reportId: (created.data as { recordId: string }).recordId } }
}
