/**
 * Extract the text content of the `<p class="normal">` that immediately follows
 * the `<h3 id="h-{fieldId}">` sidebar fact block.
 */
export function extractFact(html: string, fieldId: string): string | null {
  const re = new RegExp(
    `id="h-${fieldId}"[^>]*>[^<]+</h3>\\s*<p[^>]*>([^<]+)`,
    'i',
  )
  const m = html.match(re)
  if (!m || !m[1]) return null
  return m[1].replace(/&nbsp;/g, ' ').trim() || null
}

/** "600000:-" or "1 200 000:-" → 600000 (SEK, integer) */
export function parseSekAmount(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, '')
  const n = parseInt(digits, 10)
  return Number.isFinite(n) && n >= 1000 ? n : null
}

/** Strips HTML tags and normalises whitespace, preserving paragraph breaks. */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n +/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Extract the main listing body text (intro + content sections).
 * Returns null if nothing meaningful is found.
 */
export function extractBody(html: string): string | null {
  // Grab the Mittenspalt (centre column) which holds description + facts
  const mid = html.match(/<div[^>]+id="Mittenspalt"[^>]*>[\s\S]*?(?=<div[^>]+id="(?:Hogerspalt|svid10_6294450154af3d2b[^"]+|Footer)")/i)?.[0] ?? null
  if (!mid) return null
  const text = stripHtml(mid)
  return text.length > 20 ? text.slice(0, 3000) : null
}
