/**
 * Playtest Room end-to-end: a developer opens a room, simulated game builds
 * post telemetry to the ingest API, a tester files a report from the web, and
 * the developer's dashboard updates live. Also checks the security edges:
 * ingest auth, validation, rate limiting, owner-only actions, and the closed
 * browser path to owner-billed integrations.
 *
 * Needs two test accounts (see tests/collab.spec.ts). The AI grouping and the
 * email digest are not exercised here: both bill real credits.
 */
import type { APIRequestContext, Page } from '@playwright/test'
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'

test.skip(loadAllTestAccounts().length < 2, 'Needs 2 test accounts')

async function callActionAs(page: Page, name: string, params: Record<string, unknown>) {
  return page.evaluate(
    async ({ name, params }) => {
      const t = await fetch('/api/auth/token', { method: 'POST', credentials: 'include' }).then((r) => r.json())
      const res = await fetch(`/api/actions/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.token}` },
        body: JSON.stringify(params),
      })
      return { status: res.status, body: await res.json() }
    },
    { name, params },
  )
}

function ingest(request: APIRequestContext, roomId: string, key: string, data: unknown) {
  return request.post(`/api/ingest/${roomId}`, {
    headers: { 'X-Playtest-Key': key, 'Content-Type': 'application/json' },
    data,
  })
}

const STACK = [
  'NullReferenceException: Object reference not set to an instance of an object',
  '  at Enemy.Attack (Enemy.cs:88)',
  '  at Enemy.Update (Enemy.cs:41)',
].join('\n')

test('room lifecycle: ingest, live dashboard, tester report, permissions', async ({ users, request }) => {
  test.setTimeout(120_000)
  const [dev, tester] = await users(2)

  // Developer opens a room from the UI.
  await dev.page.goto('/rooms')
  await dev.page.getByLabel('Room name').fill('E2E room')
  await dev.page.getByLabel('WebGL build URL').fill('https://example.com/build/')
  await dev.page.getByRole('button', { name: 'Open room' }).click()
  await dev.page.waitForURL(/\/r\/[a-f0-9]{32}\/dashboard$/, { timeout: 20_000 })
  const roomId = dev.page.url().match(/\/r\/([a-f0-9]{32})\//)![1]
  const snippet = await dev.page.locator('pre').filter({ hasText: 'IngestKey' }).innerText()
  const key = snippet.match(/IngestKey = "([^"]+)"/)![1]
  expect(key).toMatch(/^pk_/)

  // The end-of-playtest digest is emailed to the address in the owner's
  // token; prove the token carries it (sending is skipped here, it bills).
  const tokenEmail = await dev.page.evaluate(async () => {
    const t = await fetch('/api/auth/token', { method: 'POST', credentials: 'include' }).then((r) => r.json())
    const payload = JSON.parse(atob(t.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return payload.email as string | undefined
  })
  expect(tokenEmail).toBe(dev.email)

  // Ingest rejects a wrong key and a malformed body.
  expect((await ingest(request, roomId, 'pk_wrong', { sessionId: 'sess-aaaaaaaa', events: [] })).status()).toBe(401)
  expect((await ingest(request, roomId, key, { sessionId: 'x', events: [] })).status()).toBe(400)

  // Two players; both hit the same crash (different line numbers in the message).
  for (const [sid, name, line] of [
    ['sess-aaaaaaaa', 'Ada', 88],
    ['sess-bbbbbbbb', 'Bo', 91],
  ] as const) {
    const res = await ingest(request, roomId, key, {
      sessionId: sid,
      playerName: name,
      buildVersion: '0.1',
      platform: 'WebGL',
      events: [
        { type: 'session_start', level: 'Road' },
        { type: 'heartbeat', level: 'Road', fpsAvg: 58, fpsMin: 41 },
        { type: 'death', level: 'Road', position: { x: 1, y: 0, z: 2 } },
        { type: 'error', level: 'Road', message: `NullReferenceException at line ${line}`, stack: STACK },
      ],
    })
    expect(res.status(), await res.text()).toBe(200)
  }

  // The dashboard shows both live players and ONE grouped crash seen twice.
  await expect(dev.page.getByText('Playing now').locator('..')).toContainText('2', { timeout: 15_000 })
  const crash = dev.page.getByRole('button', { name: /NullReferenceException/ })
  await expect(crash).toHaveCount(1)
  await expect(crash).toContainText('×2')
  await expect(crash).toContainText('line 88') // title is from the first occurrence
  await expect(crash).toContainText('2 players')

  // Tester plays: room page loads with the build embedded and room config in the URL.
  await tester.page.goto(`/r/${roomId}`)
  const frame = tester.page.locator('iframe')
  await expect(frame).toHaveAttribute('src', new RegExp(`ptRoom=${roomId}`))
  await expect(tester.page.getByRole('link', { name: 'Dashboard' })).toHaveCount(0)

  // Tester files a report; the developer sees it without reloading.
  await tester.page.getByLabel('What happened?').fill('The Abbess one-shots me through the dodge roll')
  await tester.page.getByRole('button', { name: 'Send report' }).click()
  await expect(dev.page.getByText('The Abbess one-shots me through the dodge roll')).toBeVisible({ timeout: 15_000 })
  await crash.click()
  await dev.page.screenshot({ path: 'test-results/dashboard.png', fullPage: true })
  await tester.page.screenshot({ path: 'test-results/play.png', fullPage: true })

  // Owner-only actions refuse the tester; the dashboard route does too.
  const rotate = await callActionAs(tester.page, 'rotateIngestKey', { roomId })
  expect(rotate.body).toMatchObject({ success: false, error: 'Only the room owner can do that' })
  await tester.page.goto(`/r/${roomId}/dashboard`)
  await expect(tester.page.getByText('Only the room owner can see the dashboard.')).toBeVisible()

  // Owner-billed integrations are closed to the browser.
  const ai = await tester.page.evaluate(async () => {
    const t = await fetch('/api/auth/token', { method: 'POST', credentials: 'include' }).then((r) => r.json())
    const res = await fetch('/api/integrations/anthropic/chat-completion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.token}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }),
    })
    return res.status
  })
  expect(ai).toBe(403)

  // One session cannot flood the room: past its burst it gets 429s.
  const statuses: number[] = []
  for (let i = 0; i < 16; i++) {
    statuses.push((await ingest(request, roomId, key, { sessionId: 'sess-flood000', events: [{ type: 'custom', message: `n${i}` }] })).status())
  }
  expect(statuses).toContain(429)
  expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(11)

  // Rotating the key locks out the old one.
  const rotated = await callActionAs(dev.page, 'rotateIngestKey', { roomId })
  expect(rotated.body.success).toBe(true)
  expect((await ingest(request, roomId, key, { sessionId: 'sess-cccccccc', events: [] })).status()).toBe(401)
})
