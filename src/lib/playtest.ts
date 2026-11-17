import { getAuthToken } from 'deepspace'

export type RoomIndex = { name: string; gameUrl: string; ownerId: string; status: 'live' | 'ended' }

export type RoomInfo = {
  name: string
  gameUrl: string
  ownerId: string
  ownerName: string
  status: 'live' | 'ended'
  ingestKey: string
  endedAt?: number
  clusteredAt?: number
}

export type Session = {
  playerName: string
  buildVersion: string
  platform: string
  level: string
  status: 'live' | 'ended'
  startedAt: number
  lastSeenAt: number
  endedAt?: number
  fpsAvg: number
  fpsMin: number
  fpsSamples: number
  deaths: number
  errors: number
  eventCount: number
}

export type GameEvent = {
  sessionId: string
  playerName: string
  type: 'session_start' | 'session_end' | 'death' | 'level' | 'error' | 'custom'
  level: string
  message: string
  position: { x: number; y: number; z: number } | null
  issueId: string
  ts: number
}

export type Report = {
  sessionId: string
  source: 'game' | 'web'
  playerName: string
  category: 'bug' | 'balance' | 'ux' | 'other'
  note: string
  level: string
  position: { x: number; y: number; z: number } | null
  screenshotKey: string
  issueId: string
}

export type Issue = {
  kind: 'crash' | 'feedback'
  title: string
  summary: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  status: 'open' | 'fixed'
  count: number
  players: number
  sample: string
  firstSeenAt: number
  lastSeenAt: number
}

export const roomScope = (roomId: string) => `room:${roomId}`

/** Call a server action with the signed-in user's token. Throws on failure. */
export async function callAction<T = unknown>(name: string, params: Record<string, unknown>): Promise<T> {
  const token = await getAuthToken()
  if (!token) throw new Error('Sign in first')
  const res = await fetch(`/api/actions/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(params),
  })
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T; error?: string }
  if (!res.ok || !body.success) throw new Error(body.error || `Request failed (${res.status})`)
  return body.data as T
}

/**
 * The URL the room page embeds. The Unity reporter reads these query
 * parameters, so one hosted build reports to whichever room embeds it.
 */
export function embedUrl(info: RoomInfo, roomId: string, playerName: string): string {
  const url = new URL(info.gameUrl)
  url.searchParams.set('ptRoom', roomId)
  url.searchParams.set('ptKey', info.ingestKey)
  url.searchParams.set('ptEndpoint', window.location.origin)
  url.searchParams.set('ptPlayer', playerName.slice(0, 40))
  return url.toString()
}

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export function duration(fromMs: number, toMs: number): string {
  const s = Math.max(0, Math.round((toMs - fromMs) / 1000))
  const m = Math.floor(s / 60)
  return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

export const SEVERITY_ORDER: Record<Issue['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3 }
