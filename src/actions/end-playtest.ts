/**
 * End a playtest: stop accepting telemetry, close open sessions, and email
 * the owner a digest of what happened.
 */

import { verifyJwt } from 'deepspace/worker'
import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { ingestGate } from '../server/ingest.js'
import { requireRoomOwner } from './room-access.js'

type Rec<T> = { recordId: string; data: T }
type Session = { playerName: string; status: string; fpsAvg: number; fpsMin: number; deaths: number; errors: number; startedAt: number; lastSeenAt: number }
type Issue = { kind: string; title: string; severity: string; status: string; count: number }

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

export const endPlaytest: ActionHandler<Env> = async ({ userId, params, tools, env, callerJwt }) => {
  const room = await requireRoomOwner(env, userId, callerJwt, params.roomId)
  if (!room.ok) return room.result
  const now = Date.now()

  await room.tools.update('room_info', 'info', { status: 'ended', endedAt: now })
  await tools.update('rooms', room.roomId, { status: 'ended' })
  await ingestGate(env, room.roomId).fetch(`https://gate/invalidate?room=${room.roomId}`)

  const sessionsRes = await room.tools.query('sessions', { limit: 500 })
  const sessions = sessionsRes.success ? (sessionsRes.data as unknown as { records: Rec<Session>[] }).records : []
  for (const s of sessions) {
    if (s.data.status === 'live') await room.tools.update('sessions', s.recordId, { status: 'ended', endedAt: s.data.lastSeenAt })
  }

  const issuesRes = await room.tools.query('issues', { where: { status: 'open' }, limit: 200 })
  const issues = issuesRes.success ? (issuesRes.data as unknown as { records: Rec<Issue>[] }).records : []
  const reportsRes = await room.tools.query('reports', { limit: 500 })
  const reportCount = reportsRes.success ? (reportsRes.data as { count: number }).count : 0

  const digest = buildDigest(room.info.name, sessions.map((s) => s.data), issues.map((i) => i.data), reportCount)

  // The owner's address comes from their verified sign-in token. The app's
  // `users` collection is not a reliable source: in the first live playtest
  // the lookup returned no email and the digest was silently not sent.
  const verified = await verifyJwt({ publicKey: env.AUTH_JWT_PUBLIC_KEY, issuer: env.AUTH_JWT_ISSUER }, callerJwt)
  let email = verified.result?.claims.email
  if (!email) {
    const user = await tools.get('users', userId)
    email = user.success ? (user.data as { record?: { data: { email?: string } } }).record?.data.email : undefined
  }
  let emailed = false
  if (!email) console.warn(`[endPlaytest] no email address for owner ${userId}; digest not sent`)
  if (email) {
    const sent = await tools.integration('email/send', {
      to: email,
      subject: `Playtest digest: ${room.info.name}`,
      text: digest,
    })
    emailed = sent.success
    if (!sent.success) console.warn(`[endPlaytest] digest email failed: ${sent.error}`)
  }

  return { success: true, data: { emailed, digest } }
}

export function buildDigest(name: string, sessions: Session[], issues: Issue[], reportCount: number): string {
  const players = new Set(sessions.map((s) => s.playerName)).size
  const minutes = sessions.reduce((sum, s) => sum + Math.max(0, (s.lastSeenAt - s.startedAt) / 60000), 0)
  const withFps = sessions.filter((s) => s.fpsAvg > 0)
  const avgFps = withFps.length ? withFps.reduce((a, s) => a + s.fpsAvg, 0) / withFps.length : 0
  const minFps = withFps.length ? Math.min(...withFps.map((s) => s.fpsMin || s.fpsAvg)) : 0
  const deaths = sessions.reduce((a, s) => a + (s.deaths || 0), 0)
  const errors = sessions.reduce((a, s) => a + (s.errors || 0), 0)
  const top = [...issues]
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || b.count - a.count)
    .slice(0, 8)

  return [
    `Playtest digest: ${name}`,
    '',
    `${sessions.length} sessions from ${players} players, ${Math.round(minutes)} minutes played.`,
    `Average FPS ${avgFps.toFixed(1)} (lowest sample ${Math.round(minFps)}). ${deaths} deaths, ${errors} errors logged.`,
    `${reportCount} player reports.`,
    '',
    top.length ? 'Open issues, most severe first:' : 'No open issues.',
    ...top.map((i) => `- [${i.severity}] ${i.kind === 'crash' ? 'Crash' : 'Feedback (AI-written title)'}: ${i.title} (${i.count}x)`),
  ].join('\n')
}
