# Playtest Room

Live playtests for Unity WebGL games, built on [DeepSpace](https://docs.deep.space).

Testers play your build in the browser. Sessions, FPS, deaths, errors and in-game bug reports (F8, with a
screenshot) stream into the developer's dashboard as they happen. Crashes group themselves by stack
trace; free-text reports are grouped by an AI pass on demand. Ending a playtest emails a digest.

**Live:** https://playtest-room.app.space · **Demo game:** The Hollow Games (Unity 6, WebGL)

## How it fits together

```
 Unity WebGL build (itch.io / GitHub Pages)           playtest-room.app.space (Cloudflare Worker)
 ┌───────────────────────────────┐   POST /api/ingest/:roomId   ┌──────────────────────────────┐
 │ PlaytestReporter.cs           │  X-Playtest-Key, JSON batch  │ Hono route: size cap, CORS   │
 │  batches events every 2s      ├─────────────────────────────►│        │                     │
 │  FPS / errors / scene / F8    │                              │        ▼                     │
 └───────────────────────────────┘                              │ IngestGate DO (one per room) │
        ▲ embedded in an iframe with                            │  key check (cached 30s)      │
        │ ?ptRoom&ptKey&ptEndpoint&ptPlayer                     │  token buckets room+session  │
 ┌──────┴────────────────────────┐                              │  serialized writes, crash    │
 │ /r/:roomId   (tester)         │◄──── live WebSocket ────┐    │  fingerprints + counts       │
 │ /r/:roomId/dashboard (owner)  │                         │    └────────┬─────────────────────┘
 └───────────────────────────────┘                         │             ▼ RBAC-off tools API
                                                     ┌─────┴───────────────────────────────┐
                                                     │ RecordRoom DO  room:<roomId>        │
                                                     │ room_info · sessions · events ·     │
                                                     │ reports · issues                    │
                                                     └─────────────────────────────────────┘
```

| DeepSpace piece | Used for |
| --- | --- |
| Records + real-time sync (RecordRoom) | One record scope per room; the dashboard is a set of live queries |
| Auth + RBAC | Sign-in; telemetry collections are read-only to clients, reports are member-writable |
| Server actions | Room creation, key rotation, issue status, AI grouping, ending a playtest, all owner-checked |
| Presence | Who is in the room on the play page |
| Files (R2) | In-game screenshots |
| Integrations: `anthropic/chat-completion` | Grouping free-text reports into issues |
| Integrations: `email/send` | End-of-playtest digest |
| Scheduled jobs | Every 2 min, close sessions whose tab closed without saying goodbye |
| Custom Durable Object | `IngestGate`: rate limits and serialized counters per room |

## Decisions and tradeoffs

- **Builds are hosted elsewhere, not uploaded here.** DeepSpace file storage refuses JavaScript uploads
  and the free tier has 128 MiB, while a Unity WebGL build is tens of MB of loader JS and wasm. Running
  uploaded JS on the app's own origin would also be an XSS risk. So the build lives on any static host and
  is embedded in a sandboxed iframe; the reporter talks to the ingest API cross-origin.
- **The ingest key is publishable, like a Sentry DSN.** It ships inside the build, so the design doesn't
  pretend it's a secret: it can only append telemetry to one room, the gate rate-limits it (room 5 req/s,
  session 1 req/s, bursts 60/10), payloads are schema-validated and size-capped, and the owner can rotate it.
- **A Durable Object per room for ingest**, because rate limits and counters need one consistent owner.
  Worker isolates don't share memory and the platform has no rate-limit binding. The gate serializes a
  room's writes so crash counts and per-session FPS aggregates are read-modify-write safe.
- **Crashes are grouped deterministically, feedback by AI.** Stack fingerprints (message with numbers and
  quoted values stripped, plus the top 3 frames) are free, instant, and stable. Free text ("the boss is
  unfair") has no fingerprint, so a small Claude model groups it, only when the owner asks (it bills the
  owner), at most once a minute and 60 reports per run.
- **Owner-billed integrations are closed to the browser.** The scaffold's `/api/integrations` proxy lets
  any signed-in user call owner-billed endpoints. This app returns 403 for those; AI and email are
  reachable only through owner-checked server actions.
- **Link-shared rooms.** Anyone signed in with a room link can play and report (room ids are 128-bit
  random). Invite lists were left out: playtests are usually shared by link, and RBAC would add a
  membership UI without changing the core loop.
- **Left out:** issue-tracker sync (Jira/GitHub), session replays, heatmaps. Positions are already
  captured for deaths and reports, so a death heatmap is the natural next step.

## Running it

```bash
npm install
npx deepspace auth login
npx deepspace dev start          # http://localhost:5173
npx deepspace test run all       # Playwright: two-user room lifecycle + security edges
npx vitest run                   # unit tests (crash fingerprinting)
npx deepspace deploy
```

The multi-user spec needs two DeepSpace test accounts (`npx deepspace test accounts create …`).

## Adding the reporter to a Unity game

1. Copy `unity/PlaytestReporter.cs` into `Assets/`. It starts itself only when room settings are present,
   so normal builds are unaffected.
2. Optional: report game-specific moments with `PlaytestReporter.Death(pos, "cause")`,
   `PlaytestReporter.Mark("text", pos)` and `PlaytestReporter.SetLevel("name")`.
   `unity/examples/HollowGamesPlaytest.cs` does this for The Hollow Games without touching its scripts.
3. Build WebGL (`unity/Editor/PlaytestWebGLBuild.cs` adds **Playtest Room > Build WebGL**: textures capped at
   256 px for the web, gzip with
   decompression fallback and full stack traces) and host the output on any static host.
4. Open a room, paste the build URL, share the tester link. Players press **F8** in game to report.

## Credits

The Hollow Games demo was made by Okiki Popoola and Ebube Eze for COSC 332.
