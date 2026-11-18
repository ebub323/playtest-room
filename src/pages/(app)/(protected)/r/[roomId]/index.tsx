/**
 * /r/:roomId: where testers play. The hosted build runs in an iframe with the
 * room's reporting config in its URL; feedback can also be filed here.
 */

import { useMemo, useState, type FormEvent } from 'react'
import { useMutations, usePresenceRoom, useQuery, useUser } from 'deepspace'
import { Button, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea, useToast } from '@/components/ui'
import { embedUrl, roomScope, timeAgo, type Report, type Session } from '@/lib/playtest'
import { useRoom } from './_layout'

export default function PlayPage() {
  const { roomId, info, isOwner } = useRoom()
  const { user } = useUser()
  const playerName = user?.name || 'Tester'
  const { peers } = usePresenceRoom(roomScope(roomId))
  const { records: sessions } = useQuery<Session>('sessions', { where: { status: 'live' }, limit: 50 })

  const src = useMemo(
    () => (info.gameUrl && info.status === 'live' ? embedUrl(info, roomId, playerName) : ''),
    [info, roomId, playerName],
  )

  return (
    <div className="grid gap-6 p-4 sm:p-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <section className="min-w-0">
        <div className="aspect-video w-full overflow-hidden rounded-md border border-border bg-black">
          {src ? (
            <iframe
              title={`${info.name} game build`}
              src={src}
              className="h-full w-full"
              // The build is on its own origin (itch.io, GitHub Pages), so
              // allow-same-origin gives it that origin, never this app's.
              sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-forms"
              allow="fullscreen; gamepad; autoplay"
              allowFullScreen
            />
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
              {info.status === 'ended'
                ? 'This playtest has ended. Thanks for playing.'
                : info.gameUrl
                  ? 'This build URL cannot be embedded. Builds must be on an https:// host outside app.space.'
                  : isOwner
                  ? 'Add your WebGL build URL on the Dashboard to start the playtest.'
                  : 'The developer has not added a build yet.'}
            </div>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Press <kbd className="rounded border border-border px-1 font-mono">F8</kbd> in the game to send a bug report with a
          screenshot, or use the form here.
        </p>
      </section>

      <aside className="flex flex-col gap-6">
        <section>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">In the room</h2>
          <ul className="space-y-1 text-sm">
            <li className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" /> {playerName} (you)
            </li>
            {peers.map((p) => (
              <li key={p.userId} className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" /> {p.userName}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            {sessions.length} {sessions.length === 1 ? 'game session' : 'game sessions'} reporting live
          </p>
        </section>

        {info.status === 'live' && <FeedbackForm playerName={playerName} />}
        <MyReports />
      </aside>
    </div>
  )
}

function FeedbackForm({ playerName }: { playerName: string }) {
  const { createConfirmed, ready } = useMutations<Report>('reports')
  const { success, error } = useToast()
  const [note, setNote] = useState('')
  const [category, setCategory] = useState<Report['category']>('bug')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!note.trim() || busy) return
    setBusy(true)
    try {
      await createConfirmed({
        sessionId: '',
        source: 'web',
        playerName,
        category,
        note: note.trim().slice(0, 2000),
        level: '',
        position: null,
        screenshotKey: '',
        issueId: '',
      })
      setNote('')
      success('Report sent', 'The developer sees it now.')
    } catch (err) {
      error('Could not send the report', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-md border border-border bg-card p-4">
      <h2 className="text-sm font-medium">Report something</h2>
      <div className="grid gap-1.5">
        <Label htmlFor="category">Type</Label>
        <Select value={category} onValueChange={(v) => setCategory(v as Report['category'])}>
          <SelectTrigger id="category">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="bug">Bug</SelectItem>
            <SelectItem value="balance">Too hard or too easy</SelectItem>
            <SelectItem value="ux">Confusing or unclear</SelectItem>
            <SelectItem value="other">Other</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="note">What happened?</Label>
        <Textarea
          id="note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={4}
          maxLength={2000}
          placeholder="I fell through the floor near the colosseum gate…"
        />
      </div>
      <Button type="submit" className="w-full" disabled={!ready || busy || !note.trim()}>
        {busy ? 'Sending…' : 'Send report'}
      </Button>
    </form>
  )
}

function MyReports() {
  const { user } = useUser()
  const { records: all } = useQuery<Report>('reports', { where: { source: 'web' }, orderBy: 'createdAt', orderDir: 'desc', limit: 100 })
  const records = all.filter((r) => r.createdBy === user?.id).slice(0, 5)
  if (!user?.id || records.length === 0) return null
  return (
    <section>
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Your recent reports</h2>
      <ul className="space-y-2 text-sm">
        {records.map((r) => (
          <li key={r.recordId} className="rounded border border-border px-3 py-2">
            <p className="line-clamp-2">{r.data.note}</p>
            <p className="mt-1 text-xs text-muted-foreground">{timeAgo(Date.parse(r.createdAt))}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
