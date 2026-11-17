/** Pure helpers for the ingest gate, kept free of Worker imports so they unit-test in Node. */

/**
 * Crash grouping key: the error message with numbers, hex and quoted values
 * normalized away, plus the first three stack frames. Two players hitting the
 * same NullReferenceException in the same method land on one issue.
 */
export async function crashFingerprint(message: string, stack = ''): Promise<string> {
  const norm = (s: string) =>
    s
      .replace(/0x[0-9a-f]+/gi, '#')
      .replace(/\d+/g, '#')
      .replace(/(['"]).*?\1/g, '"…"')
      .trim()
  const frames = stack
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map(norm)
  const input = `${norm(message.split('\n')[0] ?? '')}|${frames.join('|')}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')
}
