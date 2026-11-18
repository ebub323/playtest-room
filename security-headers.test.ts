// Node-only (reads public/_headers), so it lives at the root beside
// prerender.test.ts rather than in the browser/Worker project under src/.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SECURITY_HEADERS, withSecurityHeaders } from './src/server/security-headers'

function parseHeadersFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = /^\s+([A-Za-z-]+):\s*(.*)$/.exec(line)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

describe('security headers', () => {
  it('public/_headers matches the worker list exactly', () => {
    const file = parseHeadersFile(readFileSync(new URL('./public/_headers', import.meta.url), 'utf8'))
    expect(file).toEqual(SECURITY_HEADERS)
  })

  it('adds missing headers and keeps ones a route set', () => {
    const res = withSecurityHeaders(
      new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json', 'X-Frame-Options': 'SAMEORIGIN' } }),
    )
    expect(res.status).toBe(404)
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains')
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'")
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
    expect(res.headers.get('Content-Type')).toBe('application/json')
  })
})
