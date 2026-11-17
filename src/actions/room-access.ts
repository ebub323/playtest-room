/**
 * Shared helpers for Playtest Room server actions.
 *
 * Server action tools run with RBAC off, so every action that takes a room id
 * from the client must establish ownership itself. `requireRoomOwner` is the
 * single place that check lives.
 */

import type { ActionResult, ActionTools } from 'deepspace/worker'
import { createActionTools } from '../server/action-routes.js'
import type { Env } from '../../worker.js'

export const ROOM_ID_RE = /^[a-f0-9]{32}$/

export type RoomInfo = {
  name: string
  gameUrl: string
  ownerId: string
  ownerName: string
  status: 'live' | 'ended'
  ingestKey: string
  endedAt?: number
}

export function roomScope(roomId: string): string {
  return `room:${roomId}`
}

export function newRoomId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

/** 24 random bytes, base64url, with a recognizable prefix. */
export function newIngestKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return `pk_${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}

/**
 * Game URLs are embedded in an iframe on the room page. Only https is
 * accepted in production; http is allowed for localhost while developing.
 */
export function validateGameUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 500) return null
  try {
    const url = new URL(raw)
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    if (url.protocol === 'https:' || (url.protocol === 'http:' && local)) return url.toString()
    return null
  } catch {
    return null
  }
}

export function roomTools(env: Env, userId: string, callerJwt: string, roomId: string): ActionTools {
  return createActionTools(env, userId, callerJwt, roomScope(roomId))
}

export async function readRoomInfo(tools: ActionTools): Promise<RoomInfo | null> {
  const r = await tools.get('room_info', 'info')
  if (!r.success) return null
  const { record } = r.data as unknown as { record?: { data: RoomInfo } }
  return record?.data ?? null
}

/** Resolve a room the caller owns, or a failed ActionResult to return as-is. */
export async function requireRoomOwner(
  env: Env,
  userId: string,
  callerJwt: string,
  rawRoomId: unknown,
): Promise<
  | { ok: true; roomId: string; tools: ActionTools; info: RoomInfo }
  | { ok: false; result: ActionResult<never> }
> {
  if (typeof rawRoomId !== 'string' || !ROOM_ID_RE.test(rawRoomId)) {
    return { ok: false, result: { success: false, error: 'Invalid room id' } }
  }
  const tools = roomTools(env, userId, callerJwt, rawRoomId)
  const info = await readRoomInfo(tools)
  if (!info) return { ok: false, result: { success: false, error: 'Room not found' } }
  if (info.ownerId !== userId) {
    return { ok: false, result: { success: false, error: 'Only the room owner can do that' } }
  }
  return { ok: true, roomId: rawRoomId, tools, info }
}
