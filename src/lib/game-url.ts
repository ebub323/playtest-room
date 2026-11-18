/**
 * Game URL rules, shared by the server actions that store a room's build URL
 * and the room page that embeds it.
 *
 * The build runs in an iframe sandboxed with `allow-scripts allow-same-origin`,
 * which is only safe while the build is on a different origin from this app.
 * A page on this app's own host (or another DeepSpace app on *.app.space)
 * would get script access to a same-site origin, so those hosts are refused.
 */

const BLOCKED_HOST_SUFFIXES = ['app.space']

function isBlockedHost(hostname: string, ownHost?: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (ownHost && host === ownHost.toLowerCase().split(':')[0]) return true
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

/**
 * Normalized URL, or null when it may not be embedded. Only https is accepted
 * in production; http is allowed for localhost while developing.
 * `ownHost` is the host this app is served from, when known.
 */
export function validateGameUrl(raw: unknown, ownHost?: string): string | null {
  if (typeof raw !== 'string' || raw.length > 500) return null
  try {
    const url = new URL(raw)
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local))) return null
    if (url.username || url.password) return null
    if (isBlockedHost(url.hostname, ownHost)) return null
    return url.toString()
  } catch {
    return null
  }
}

export const GAME_URL_RULES = 'Game URL must be an https:// link to where your build is hosted (not an app.space address)'
