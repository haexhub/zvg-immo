export function clean(s: string | null | undefined): string | null {
  const t = s?.replace(/\s+/g, ' ').trim()
  return t && t.length > 0 ? t : null
}

/** "14.07.2026 kl 10:00" → { iso: "2026-07-14T10:00:00", label: "14.07.2026, 10:00 Uhr" } */
export function parseEeDateTime(raw: string | null): { iso: string | null; label: string | null } {
  if (!raw) return { iso: null, label: null }
  const m = raw.match(/(\d{2})\.(\d{2})\.(\d{4})\s+kl\s+(\d{2}):(\d{2})/)
  if (!m) return { iso: null, label: null }
  const [, d, mo, y, hh, mm] = m
  return {
    iso: `${y}-${mo}-${d}T${hh}:${mm}:00`,
    label: `${d}.${mo}.${y}, ${hh}:${mm} Uhr`,
  }
}

/** "1 800 €" or "65 610 €" → 1800 / 65610 */
export function parseEePrice(raw: string | null): number | null {
  if (!raw) return null
  const digits = raw.replace(/[^\d]/g, '')
  if (!digits) return null
  const n = parseInt(digits, 10)
  return Number.isFinite(n) ? n : null
}

/** Strips the announcement's inline-styled HTML down to plain text, keeping
 *  paragraph breaks so the free-text notice stays readable as beschreibung. */
export function stripAnnouncementHtml(html: string): string {
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
