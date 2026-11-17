/**
 * Landing page: a static, prerendered page (no auth, no WebSocket).
 */

import { Link } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { seo } from '../seo'

const STEPS = [
  ['Host your build', 'Put your Unity WebGL build on itch.io, GitHub Pages, or anywhere with https.'],
  ['Drop in the reporter', 'One C# script sends sessions, deaths, FPS, errors and F8 bug reports with screenshots.'],
  ['Share the room link', 'Testers play in the browser. You watch the dashboard fill in live.'],
] as const

export default function Landing() {
  return (
    <>
      <Seo {...seo} path="/" />
      <main data-testid="static-landing" className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center px-6 py-16">
        <p className="mb-6 flex items-center gap-2 font-mono text-xs uppercase tracking-[0.2em] text-primary">
          <span className="h-2 w-2 animate-pulse rounded-full bg-primary" aria-hidden />
          Playtest Room
        </p>
        <h1 className="max-w-3xl text-4xl font-semibold leading-[1.1] tracking-tight text-foreground sm:text-6xl">
          Watch your playtest happen, not the week after.
        </h1>
        <p className="mt-6 max-w-xl text-lg text-muted-foreground">
          Testers play your Unity WebGL build in the browser. Crashes group themselves by stack trace, FPS and
          deaths stream in per player, and an AI pass turns forty bug reports into six issues.
        </p>
        <div className="mt-10 flex flex-wrap gap-3">
          <Link
            to="/rooms"
            className="inline-flex items-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Open a room
          </Link>
          <a
            href="https://github.com/ebub323/playtest-room"
            className="inline-flex items-center rounded-md border border-border px-5 py-2.5 text-sm font-medium text-foreground hover:bg-accent"
          >
            Source and Unity script
          </a>
        </div>
        <ol className="mt-16 grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-3">
          {STEPS.map(([title, body], i) => (
            <li key={title} className="bg-card p-5">
              <p className="font-mono text-xs text-primary">0{i + 1}</p>
              <p className="mt-2 font-medium text-foreground">{title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{body}</p>
            </li>
          ))}
        </ol>
      </main>
    </>
  )
}
