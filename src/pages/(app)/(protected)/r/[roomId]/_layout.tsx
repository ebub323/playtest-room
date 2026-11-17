/**
 * Room boundary: mounts the room's own record scope (`room:<roomId>`, a
 * separate Durable Object) so every page under /r/:roomId reads that room's
 * live data, and shares the room's info through context.
 */

import { createContext, useContext } from 'react'
import { NavLink, Outlet, useParams } from 'react-router-dom'
import { RecordScope, useAuth, useQuery, type RecordData } from 'deepspace'
import { cn } from '@/components/ui'
import { schemas } from '@/schemas'
import { roomScope, type RoomInfo } from '@/lib/playtest'

type RoomContextValue = { roomId: string; info: RoomInfo; isOwner: boolean }
const RoomContext = createContext<RoomContextValue | null>(null)

export function useRoom(): RoomContextValue {
  const ctx = useContext(RoomContext)
  if (!ctx) throw new Error('useRoom must be used inside /r/:roomId')
  return ctx
}

export default function RoomLayout() {
  const { roomId = '' } = useParams()
  if (!/^[a-f0-9]{32}$/.test(roomId)) return <RoomMessage title="That room link isn't valid" />
  return (
    <RecordScope roomId={roomScope(roomId)} schemas={schemas}>
      <RoomShell roomId={roomId} />
    </RecordScope>
  )
}

function RoomShell({ roomId }: { roomId: string }) {
  const { userId } = useAuth()
  const { records, status } = useQuery<RoomInfo>('room_info')
  const info = (records as RecordData<RoomInfo>[]).find((r) => r.recordId === 'info')?.data

  if (status === 'loading') return <RoomMessage title="Connecting to the room…" muted />
  if (!info) return <RoomMessage title="Room not found" body="Check the link with whoever shared it." />

  const isOwner = info.ownerId === userId
  return (
    <RoomContext.Provider value={{ roomId, info, isOwner }}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-shell-panel px-4 py-2.5 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className={cn('h-2 w-2 shrink-0 rounded-full', info.status === 'live' ? 'animate-pulse bg-primary' : 'bg-muted-foreground')}
              aria-hidden
            />
            <h1 className="truncate font-semibold">{info.name}</h1>
            <span className="hidden text-xs text-muted-foreground sm:inline">by {info.ownerName}</span>
            {info.status === 'ended' && <span className="text-xs text-muted-foreground">· ended</span>}
          </div>
          <nav className="flex gap-1 text-sm">
            <TabLink to={`/r/${roomId}`} end>
              Play
            </TabLink>
            {isOwner && <TabLink to={`/r/${roomId}/dashboard`}>Dashboard</TabLink>}
          </nav>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </div>
    </RoomContext.Provider>
  )
}

function TabLink({ to, end, children }: { to: string; end?: boolean; children: string }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'rounded px-3 py-1 transition-colors',
          isActive ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
        )
      }
    >
      {children}
    </NavLink>
  )
}

function RoomMessage({ title, body, muted }: { title: string; body?: string; muted?: boolean }) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-2 px-6 text-center">
      <p className={cn('font-medium', muted && 'text-muted-foreground')}>{title}</p>
      {body && <p className="text-sm text-muted-foreground">{body}</p>}
    </div>
  )
}
