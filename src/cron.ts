/**
 * Scheduled tasks, run by the AppCronRoom Durable Object (worker.ts).
 *
 * close-idle-sessions: a browser tab that is closed mid-game never sends
 * `session_end`, so sessions would stay "live" forever. Every two minutes,
 * each live room's ingest gate closes sessions with no traffic for 3 minutes.
 */

import type { CronTask } from 'deepspace/worker'
import type { Env } from '../worker.js'
import { createActionTools } from './server/action-routes.js'
import { ingestGate } from './server/ingest.js'

export const tasks: CronTask[] = [{ name: 'close-idle-sessions', intervalMinutes: 2 }]

export async function runTask(name: string, env: Env): Promise<void> {
  if (name !== 'close-idle-sessions') return
  const tools = createActionTools(env, env.OWNER_USER_ID, '')
  const live = await tools.query('rooms', { where: { status: 'live' }, limit: 200 })
  if (!live.success) {
    console.warn(`[cron] could not list rooms: ${live.error}`)
    return
  }
  let closed = 0
  for (const room of (live.data as { records: { recordId: string }[] }).records) {
    const res = await ingestGate(env, room.recordId).fetch(`https://gate/close-idle?room=${room.recordId}`)
    if (res.ok) closed += ((await res.json()) as { closed: number }).closed
  }
  if (closed) console.info(`[cron] closed ${closed} idle sessions`)
}
