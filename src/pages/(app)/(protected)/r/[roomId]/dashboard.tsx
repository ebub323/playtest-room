/**
 * /r/:roomId/dashboard: the developer's live view of a playtest.
 *
 * Everything here is a live query on the room's record scope: sessions,
 * events, reports and issues stream in as the ingest gate writes them.
 */

import { useEffect, useMemo, useState } from 'react'
import { useQuery, useR2Files, type RecordData } from 'deepspace'
import { Badge, Button, ConfirmModal, Input, Label, cn, useToast } from '@/components/ui'
import {
  callAction,
  duration,
  SEVERITY_ORDER,
  timeAgo,
  type GameEvent,
  type Issue,
  type Report,
  type Session,
} from '@/lib/playtest'
import { useRoom } from './_layout'

/** Re-render every few seconds so "12s ago" labels and live counts stay fresh. */
function useNow(intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

export default function DashboardPage() {
  const { isOwner } = useRoom()
  if (!isOwner) {
    return <p className="p-6 text-sm text-muted-foreground">Only the room owner can see the dashboard.</p>
  }
  return <Dashboard />
}

function Dashboard() {
  const { info } = useRoom()
  const now = useNow()
  const { records: sessions } = useQuery<Session>('sessions', { orderBy: 'lastSeenAt', orderDir: 'desc', limit: 200 })
  const { records: issues } = useQuery<Issue>('issues', { limit: 200 })
  const { records: reports } = useQuery<Report>('reports', { orderBy: 'createdAt', orderDir: 'desc', limit: 200 })
  const { records: events } = useQuery<GameEvent>('events', { orderBy: 'createdAt', orderDir: 'desc', limit: 60 })

  const live = sessions.filter((s) => s.data.status === 'live')
  const withFps = sessions.filter((s) => s.data.fpsSamples > 0)
  const avgFps = withFps.length ? withFps.reduce((a, s) => a + s.data.fpsAvg, 0) / withFps.length : null
  const deaths = sessions.reduce((a, s) => a + (s.data.deaths || 0), 0)
  const errors = sessions.reduce((a, s) => a + (s.data.errors || 0), 0)

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      {(!info.gameUrl || sessions.length === 0) && info.status === 'live' && <SetupPanel defaultOpen />}

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Playing now" value={live.length} accent={live.length > 0} />
        <Stat label="Sessions" value={sessions.length} />
        <Stat label="Avg FPS" value={avgFps === null ? '–' : avgFps.toFixed(0)} warn={avgFps !== null && avgFps < 30} />
        <Stat label="Deaths" value={deaths} />
        <Stat label="Errors" value={errors} warn={errors > 0} />
        <Stat label="Reports" value={reports.length} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <IssuesPanel issues={issues} reports={reports} now={now} />
        <FeedPanel events={events} reports={reports} now={now} />
      </div>

      <SessionsPanel sessions={sessions} now={now} />

      {(info.gameUrl && sessions.length > 0) || info.status === 'ended' ? <SetupPanel /> : null}
      <EndPanel />
    </div>
  )
}

function Stat({ label, value, accent, warn }: { label: string; value: number | string; accent?: boolean; warn?: boolean }) {
  return (
    <div className="bg-card px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('mt-1 font-mono text-2xl tabular-nums', accent && 'text-primary', warn && 'text-destructive')}>{value}</p>
    </div>
  )
}

function Panel({ title, action, children, className }: { title: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-md border border-border bg-card', className)}>
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-medium">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  )
}

const SEVERITY_STYLE: Record<Issue['severity'], string> = {
  critical: 'bg-destructive text-destructive-foreground',
  high: 'bg-primary text-primary-foreground',
  medium: 'bg-secondary text-secondary-foreground',
  low: 'border border-border text-muted-foreground',
}

function IssuesPanel({ issues, reports, now }: { issues: RecordData<Issue>[]; reports: RecordData<Report>[]; now: number }) {
  const { roomId, info } = useRoom()
  const { success, error } = useToast()
  const [showFixed, setShowFixed] = useState(false)
  const [grouping, setGrouping] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const ungrouped = reports.filter((r) => !r.data.issueId).length

  const sorted = useMemo(
    () =>
      issues
        .filter((i) => showFixed || i.data.status !== 'fixed')
        .sort(
          (a, b) =>
            (a.data.status === 'fixed' ? 1 : 0) - (b.data.status === 'fixed' ? 1 : 0) ||
            SEVERITY_ORDER[a.data.severity] - SEVERITY_ORDER[b.data.severity] ||
            b.data.count - a.data.count,
        ),
    [issues, showFixed],
  )

  async function group() {
    setGrouping(true)
    try {
      const r = await callAction<{ grouped: number; issues: number }>('clusterReports', { roomId })
      success('Feedback grouped', `${r.grouped} reports into ${r.issues} new issues.`)
    } catch (err) {
      error('Grouping failed', err instanceof Error ? err.message : String(err))
    } finally {
      setGrouping(false)
    }
  }

  async function toggle(issue: RecordData<Issue>) {
    try {
      await callAction('setIssueStatus', { roomId, issueId: issue.recordId, status: issue.data.status === 'fixed' ? 'open' : 'fixed' })
    } catch (err) {
      error('Could not update the issue', err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Panel
      title="Issues"
      action={
        <div className="flex items-center gap-2">
          <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowFixed((v) => !v)}>
            {showFixed ? 'Hide fixed' : 'Show fixed'}
          </button>
          <Button size="sm" variant="outline" disabled={grouping || ungrouped === 0 || info.status !== 'live'} onClick={group}>
            {grouping ? 'Grouping…' : `Group ${ungrouped || ''} reports with AI`.replace('  ', ' ')}
          </Button>
        </div>
      }
    >
      {sorted.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          Crashes are grouped here automatically. Player reports join them when you group with AI.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {sorted.map((i) => {
            const linked = reports.filter((r) => r.data.issueId === i.recordId)
            const expanded = open === i.recordId
            return (
              <li key={i.recordId} className={cn(i.data.status === 'fixed' && 'opacity-50')}>
                <button className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-accent/50" onClick={() => setOpen(expanded ? null : i.recordId)}>
                  <span className={cn('mt-0.5 shrink-0 rounded px-1.5 py-px text-[10px] font-medium uppercase', SEVERITY_STYLE[i.data.severity])}>
                    {i.data.severity}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{i.data.title}</span>
                    <span className="block text-xs text-muted-foreground">
                      {i.data.kind === 'crash' ? `Crash · ${i.data.players} players` : 'Feedback'} · seen {timeAgo(i.data.lastSeenAt, now)}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-sm tabular-nums text-muted-foreground">×{i.data.count}</span>
                </button>
                {expanded && (
                  <div className="space-y-3 px-4 pb-4 pl-[4.25rem] text-sm">
                    {i.data.summary && <p className="text-muted-foreground">{i.data.summary}</p>}
                    {i.data.sample && (
                      <pre className="max-h-40 overflow-auto rounded bg-background p-3 font-mono text-xs leading-relaxed text-muted-foreground">
                        {i.data.sample}
                      </pre>
                    )}
                    {linked.length > 0 && (
                      <ul className="space-y-1">
                        {linked.slice(0, 6).map((r) => (
                          <li key={r.recordId} className="text-xs">
                            <span className="text-muted-foreground">{r.data.playerName}:</span> {r.data.note}
                          </li>
                        ))}
                      </ul>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => toggle(i)}>
                      {i.data.status === 'fixed' ? 'Reopen' : 'Mark fixed'}
                    </Button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

type FeedItem =
  | { kind: 'event'; at: number; rec: RecordData<GameEvent> }
  | { kind: 'report'; at: number; rec: RecordData<Report> }

const EVENT_LABEL: Record<GameEvent['type'], string> = {
  session_start: 'joined',
  session_end: 'left',
  death: 'died',
  level: 'entered',
  error: 'hit an error',
  custom: 'marked',
}

function FeedPanel({ events, reports, now }: { events: RecordData<GameEvent>[]; reports: RecordData<Report>[]; now: number }) {
  const { getUrl } = useR2Files({ scope: 'app' })
  const items: FeedItem[] = [
    ...events.map((rec) => ({ kind: 'event' as const, at: rec.data.ts || Date.parse(rec.createdAt), rec })),
    ...reports.slice(0, 40).map((rec) => ({ kind: 'report' as const, at: Date.parse(rec.createdAt), rec })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 60)

  return (
    <Panel title="Live feed" className="flex max-h-[34rem] flex-col">
      {items.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">Waiting for players…</p>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
          {items.map((item) =>
            item.kind === 'event' ? (
              <li key={`e-${item.rec.recordId}`} className="flex gap-3 px-4 py-2 text-sm">
                <span className="w-16 shrink-0 whitespace-nowrap font-mono text-xs leading-5 text-muted-foreground">{timeAgo(item.at, now)}</span>
                <span className={cn('min-w-0', item.rec.data.type === 'error' && 'text-destructive')}>
                  <span className="font-medium">{item.rec.data.playerName}</span> {EVENT_LABEL[item.rec.data.type] ?? item.rec.data.type}
                  {item.rec.data.type === 'level' ? ` ${item.rec.data.message}` : ''}
                  {item.rec.data.type !== 'level' && item.rec.data.level ? <span className="text-muted-foreground"> in {item.rec.data.level}</span> : null}
                  {item.rec.data.type === 'error' || item.rec.data.type === 'custom' ? (
                    <span className="block truncate font-mono text-xs">{item.rec.data.message}</span>
                  ) : null}
                </span>
              </li>
            ) : (
              <li key={`r-${item.rec.recordId}`} className="flex gap-3 bg-primary/5 px-4 py-2.5 text-sm">
                <span className="w-16 shrink-0 whitespace-nowrap font-mono text-xs leading-5 text-muted-foreground">{timeAgo(item.at, now)}</span>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{item.rec.data.playerName}</span>{' '}
                  <Badge size="sm" variant="outline">
                    {item.rec.data.category}
                  </Badge>{' '}
                  <span className="text-muted-foreground">{item.rec.data.source === 'game' ? 'in game' : 'on web'}</span>
                  <span className="mt-0.5 block">{item.rec.data.note}</span>
                  {item.rec.data.screenshotKey && (
                    <a href={getUrl(item.rec.data.screenshotKey)} target="_blank" rel="noreferrer" className="mt-2 block">
                      <img
                        src={getUrl(item.rec.data.screenshotKey)}
                        alt={`Screenshot from ${item.rec.data.playerName}`}
                        className="max-h-36 rounded border border-border"
                        loading="lazy"
                      />
                    </a>
                  )}
                </span>
              </li>
            ),
          )}
        </ul>
      )}
    </Panel>
  )
}

function SessionsPanel({ sessions, now }: { sessions: RecordData<Session>[]; now: number }) {
  if (sessions.length === 0) return null
  return (
    <Panel title="Sessions">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-4 py-2 font-normal">Player</th>
              <th className="px-4 py-2 font-normal">Where</th>
              <th className="px-4 py-2 text-right font-normal">Played</th>
              <th className="px-4 py-2 text-right font-normal">FPS avg / min</th>
              <th className="px-4 py-2 text-right font-normal">Deaths</th>
              <th className="px-4 py-2 text-right font-normal">Errors</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sessions.slice(0, 50).map((s) => (
              <tr key={s.recordId}>
                <td className="px-4 py-2">
                  <span className="flex items-center gap-2">
                    <span className={cn('h-1.5 w-1.5 rounded-full', s.data.status === 'live' ? 'bg-primary' : 'bg-muted-foreground/40')} />
                    {s.data.playerName}
                  </span>
                </td>
                <td className="px-4 py-2 text-muted-foreground">{s.data.level || '–'}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">
                  {duration(s.data.startedAt, s.data.status === 'live' ? now : s.data.endedAt || s.data.lastSeenAt)}
                </td>
                <td className={cn('px-4 py-2 text-right font-mono tabular-nums', s.data.fpsAvg > 0 && s.data.fpsAvg < 30 && 'text-destructive')}>
                  {s.data.fpsSamples ? `${Math.round(s.data.fpsAvg)} / ${s.data.fpsMin}` : '–'}
                </td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">{s.data.deaths}</td>
                <td className={cn('px-4 py-2 text-right font-mono tabular-nums', s.data.errors > 0 && 'text-destructive')}>{s.data.errors}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function SetupPanel({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const { roomId, info } = useRoom()
  const { success, error } = useToast()
  const [gameUrl, setGameUrl] = useState(info.gameUrl)
  const [saving, setSaving] = useState(false)
  const [rotating, setRotating] = useState(false)
  const shareUrl = `${window.location.origin}/r/${roomId}`
  const snippet = `// PlaytestReporter reads room settings from the page URL when the
// build is embedded in Playtest Room. For local editor testing set:
RoomId   = "${roomId}";
IngestKey = "${info.ingestKey}";
Endpoint = "${window.location.origin}";`

  async function save() {
    setSaving(true)
    try {
      await callAction('updateRoom', { roomId, gameUrl: gameUrl.trim() })
      success('Build URL saved')
    } catch (err) {
      error('Could not save', err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function rotate() {
    setRotating(true)
    try {
      await callAction('rotateIngestKey', { roomId })
      success('Key rotated', 'Builds using the old key stop reporting within 30 seconds.')
    } catch (err) {
      error('Could not rotate the key', err instanceof Error ? err.message : String(err))
    } finally {
      setRotating(false)
    }
  }

  return (
    <details open={defaultOpen} className="group rounded-md border border-border bg-card">
      <summary className="cursor-pointer list-none px-4 py-2.5 text-sm font-medium marker:hidden">
        <span className="text-muted-foreground group-open:hidden">▸ </span>
        <span className="hidden text-muted-foreground group-open:inline">▾ </span>
        Setup and sharing
      </summary>
      <div className="grid gap-5 border-t border-border p-4 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="grid gap-1.5">
            <Label htmlFor="setup-url">WebGL build URL</Label>
            <div className="flex gap-2">
              <Input id="setup-url" type="url" value={gameUrl} onChange={(e) => setGameUrl(e.target.value)} placeholder="https://…" />
              <Button variant="outline" disabled={saving || gameUrl.trim() === info.gameUrl} onClick={save}>
                Save
              </Button>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>Tester link</Label>
            <div className="flex gap-2">
              <Input readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} />
              <Button
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(shareUrl)
                  success('Link copied')
                }}
              >
                Copy
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Anyone signed in with this link can play and report.</p>
          </div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Unity reporter settings</Label>
            <Button size="sm" variant="ghost" disabled={rotating} onClick={rotate}>
              {rotating ? 'Rotating…' : 'Rotate key'}
            </Button>
          </div>
          <pre className="overflow-x-auto rounded bg-background p-3 font-mono text-xs leading-relaxed">{snippet}</pre>
          <p className="text-xs text-muted-foreground">
            The ingest key is a write-only key that ships inside your build, so treat it as public. It can only add
            telemetry to this room, and the server rate-limits it. Rotate it if someone abuses it.
          </p>
        </div>
      </div>
    </details>
  )
}

function EndPanel() {
  const { roomId, info } = useRoom()
  const { success, error } = useToast()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [digest, setDigest] = useState<string | null>(null)

  if (info.status === 'ended' && !digest) return null

  async function end() {
    setBusy(true)
    try {
      const r = await callAction<{ emailed: boolean; digest: string }>('endPlaytest', { roomId })
      setDigest(r.digest)
      success('Playtest ended', r.emailed ? 'The digest is in your inbox.' : 'The digest is below.')
    } catch (err) {
      error('Could not end the playtest', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <div className="flex flex-col items-start gap-3 border-t border-border pt-6">
      {digest ? (
        <pre className="w-full whitespace-pre-wrap rounded-md border border-border bg-card p-4 font-mono text-xs leading-relaxed">{digest}</pre>
      ) : (
        <>
          <Button variant="outline" onClick={() => setConfirming(true)} disabled={busy}>
            End playtest and email digest
          </Button>
          <p className="text-xs text-muted-foreground">
            Stops accepting telemetry, closes open sessions, and emails you a summary.
          </p>
        </>
      )}
      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={end}
        title="End this playtest?"
        description="Builds stop reporting to this room. Everything collected so far stays here."
        confirmText={busy ? 'Ending…' : 'End playtest'}
      />
    </div>
  )
}
