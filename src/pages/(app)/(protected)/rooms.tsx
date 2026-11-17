/**
 * /rooms: the developer's playtest rooms, and the form to open a new one.
 */

import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth, useQuery } from 'deepspace'
import { Badge, Button, EmptyState, Input, Label, useToast } from '@/components/ui'
import { callAction, type RoomIndex } from '@/lib/playtest'

export default function RoomsPage() {
  const { userId } = useAuth()
  const { records, status } = useQuery<RoomIndex>('rooms', {
    where: userId ? { ownerId: userId } : undefined,
    orderBy: 'createdAt',
    orderDir: 'desc',
  })

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Playtest rooms</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A room is one playtest: your hosted build, the players in it, and everything they report.
        </p>
      </header>

      <NewRoomForm />

      <section className="mt-10">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-muted-foreground">Your rooms</h2>
        {status === 'loading' ? (
          <p className="text-sm text-muted-foreground">Loading rooms…</p>
        ) : records.length === 0 ? (
          <EmptyState title="No rooms yet" description="Open one above, then share its link with your testers." />
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-card">
            {records.map((r) => (
              <li key={r.recordId}>
                <Link
                  to={`/r/${r.recordId}/dashboard`}
                  className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-accent"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{r.data.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{r.data.gameUrl || 'No game URL yet'}</p>
                  </div>
                  <Badge variant={r.data.status === 'live' ? 'default' : 'secondary'}>
                    {r.data.status === 'live' ? 'Live' : 'Ended'}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function NewRoomForm() {
  const navigate = useNavigate()
  const { error } = useToast()
  const [name, setName] = useState('')
  const [gameUrl, setGameUrl] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      const { roomId } = await callAction<{ roomId: string }>('createRoom', { name, gameUrl })
      navigate(`/r/${roomId}/dashboard`)
    } catch (err) {
      error('Could not create the room', err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4 rounded-md border border-border bg-card p-5 sm:grid-cols-[1fr_1.4fr_auto] sm:items-end">
      <div className="grid gap-1.5">
        <Label htmlFor="room-name">Room name</Label>
        <Input id="room-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Hollow Games, build 12" maxLength={80} required />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="game-url">WebGL build URL</Label>
        <Input
          id="game-url"
          type="url"
          value={gameUrl}
          onChange={(e) => setGameUrl(e.target.value)}
          placeholder="https://you.itch.io/game or GitHub Pages link"
        />
      </div>
      <Button type="submit" disabled={busy || !name.trim()}>
        {busy ? 'Opening…' : 'Open room'}
      </Button>
    </form>
  )
}
