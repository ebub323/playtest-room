/**
 * Response security headers. One list, applied in two places:
 *
 * - public/_headers, for files the asset layer serves without the worker
 *   (prerendered pages, build chunks). security-headers.test.ts (app root)
 *   fails if that file drifts from this list.
 * - the worker middleware in worker.ts, for everything the worker answers
 *   (API routes, and client routes served through the SPA fallback).
 *
 * CSP notes, so additions stay deliberate:
 * - script-src 'self': the build emits no inline scripts.
 * - style-src 'unsafe-inline': index.html carries a first-paint <style>, and
 *   React/Base UI set inline style attributes.
 * - img-src https: user avatars come from the sign-in provider's CDN.
 * - connect-src 'self': every API call and WebSocket goes to this origin
 *   ('self' matches same-host ws:/wss: in current browsers).
 * - frame-src https: (plus local http, which validateGameUrl allows for
 *   development): the room page embeds the developer's hosted WebGL build,
 *   which lives on any https host (itch.io, GitHub Pages, ...).
 */

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  'frame-src https: http://localhost:* http://127.0.0.1:*',
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), document-domain=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
}

/**
 * Copy of `res` with any missing security header added. A header the route
 * already set wins. WebSocket upgrades (101) pass through untouched: their
 * response cannot be rebuilt without losing the socket.
 */
export function withSecurityHeaders(res: Response): Response {
  if (res.status === 101) return res
  const out = new Response(res.body, res)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!out.headers.has(name)) out.headers.set(name, value)
  }
  return out
}
