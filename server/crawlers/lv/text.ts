export function clean(s: string | null | undefined): string | null {
  const t = s?.replace(/\s+/g, ' ').trim()
  return t && t.length > 0 ? t : null
}

/** "€ 22 100.00" → 22100 */
export function parseLvPrice(raw: string | null | undefined): number | null {
  if (!raw) return null
  const normalised = raw.replace(/[^\d.]/g, '')
  if (!normalised) return null
  const n = parseFloat(normalised)
  return Number.isFinite(n) ? Math.round(n) : null
}

/** Reads a table cell's raw HTML and turns a `<br>`-separated date+time into
 *  one space-separated string ("16.07.2026<br/>13:00" → "16.07.2026 13:00")
 *  before stripping any remaining tags. */
export function cellText(html: string | null | undefined): string | null {
  if (!html) return null
  return clean(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' '))
}

/** "16.07.2026 13:00" or "16.07.2026" → { iso, label } */
export function parseLvDateTime(raw: string | null): { iso: string | null; label: string | null } {
  if (!raw) return { iso: null, label: null }
  const m = raw.match(/(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?/)
  if (!m) return { iso: null, label: null }
  const [, d, mo, y, hh, mm] = m
  if (!hh || !mm) return { iso: null, label: `${d}.${mo}.${y}` }
  return {
    iso: `${y}-${mo}-${d}T${hh}:${mm}:00`,
    label: `${d}.${mo}.${y}, ${hh}:${mm} Uhr`,
  }
}

/** The list page embeds each lot's official notice as HTML-escaped markup
 *  inside a hidden div (double-encoded: cheerio's .text() undoes the outer
 *  encoding, leaving literal `<p>`/`<br>` tags as text) — strip those down to
 *  plain text with paragraph breaks preserved. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
