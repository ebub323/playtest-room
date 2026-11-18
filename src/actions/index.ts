import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { ingestGate } from '../server/ingest.js'
import { clusterReports } from './cluster.js'
import { endPlaytest } from './end-playtest.js'
import {
  GAME_URL_RULES,
  newIngestKey,
  newRoomId,
  requireRoomOwner,
  roomTools,
  validateGameUrl,
} from './room-access.js'

const MAX_ROOMS_PER_USER = 20

/** Create a room: an index row in the app scope, and the room's own scope. */
const createRoom: ActionHandler<Env> = async ({ userId, params, tools, env, callerJwt }) => {
  const name = typeof params.name === 'string' ? params.name.trim().slice(0, 80) : ''
  if (!name) return { success: false, error: 'Give the room a name' }
  const gameUrl = params.gameUrl ? validateGameUrl(params.gameUrl) : ''
  if (gameUrl === null) return { success: false, error: GAME_URL_RULES }

  const mine = await tools.query('rooms', { where: { ownerId: userId }, limit: MAX_ROOMS_PER_USER + 1 })
  if (mine.success && (mine.data as { count: number }).count >= MAX_ROOMS_PER_USER) {
    return { success: false, error: `You can have up to ${MAX_ROOMS_PER_USER} rooms` }
  }

  const user = await tools.get('users', userId)
  const ownerName =
    (user.success && (user.data as { record?: { data: { name?: string } } }).record?.data.name) || 'Developer'

  const roomId = newRoomId()
  const ingestKey = newIngestKey()
  const created = await roomTools(env, userId, callerJwt, roomId).create(
    'room_info',
    { name, gameUrl, ownerId: userId, ownerName, status: 'live', ingestKey },
    'info',
  )
  if (!created.success) return created
  const indexed = await tools.create('rooms', { name, gameUrl, ownerId: userId, status: 'live' }, roomId)
  if (!indexed.success) return indexed
  return { success: true, data: { roomId } }
}

const updateRoom: ActionHandler<Env> = async ({ userId, params, tools, env, callerJwt }) => {
  const room = await requireRoomOwner(env, userId, callerJwt, params.roomId)
  if (!room.ok) return room.result
  const patch: Record<string, string> = {}
  if (typeof params.name === 'string' && params.name.trim()) patch.name = params.name.trim().slice(0, 80)
  if (params.gameUrl !== undefined) {
    const gameUrl = params.gameUrl === '' ? '' : validateGameUrl(params.gameUrl)
    if (gameUrl === null) return { success: false, error: GAME_URL_RULES }
    patch.gameUrl = gameUrl
  }
  const r = await room.tools.update('room_info', 'info', patch)
  if (!r.success) return r
  await tools.update('rooms', room.roomId, patch)
  return { success: true, data: {} }
}

/** Replace the publishable key. Old builds stop reporting within seconds. */
const rotateIngestKey: ActionHandler<Env> = async ({ userId, params, env, callerJwt }) => {
  const room = await requireRoomOwner(env, userId, callerJwt, params.roomId)
  if (!room.ok) return room.result
  const r = await room.tools.update('room_info', 'info', { ingestKey: newIngestKey() })
  if (!r.success) return r
  await ingestGate(env, room.roomId).fetch(`https://gate/invalidate?room=${room.roomId}`)
  return { success: true, data: {} }
}

const setIssueStatus: ActionHandler<Env> = async ({ userId, params, env, callerJwt }) => {
  const room = await requireRoomOwner(env, userId, callerJwt, params.roomId)
  if (!room.ok) return room.result
  const status = params.status === 'fixed' ? 'fixed' : 'open'
  if (typeof params.issueId !== 'string' || !/^[\w-]{1,80}$/.test(params.issueId)) {
    return { success: false, error: 'Invalid issue id' }
  }
  const existing = await room.tools.get('issues', params.issueId)
  if (!existing.success) return { success: false, error: 'Issue not found' }
  return room.tools.update('issues', params.issueId, { status })
}

export const actions: Record<string, ActionHandler<Env>> = {
  createRoom,
  updateRoom,
  rotateIngestKey,
  setIssueStatus,
  clusterReports,
  endPlaytest,
}
