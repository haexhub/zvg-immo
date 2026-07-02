export function parseEuroAt(text: string | null | undefined): number | null {
  if (!text) return null
  // "171.400,00 EUR" / "30.000,00&nbsp;EUR" — Austrian formatting matches German.
  const m = text.replace(/ /g, ' ').match(/([\d.]+(?:,\d+)?)\s*(?:€|EUR)/i)
  if (!m?.[1]) return null
  const normalized = m[1].replace(/\./g, '').replace(',', '.')
  const value = parseFloat(normalized)
  return Number.isFinite(value) ? value : null
}

/**
 * "09.07.2026" or "09.07.2026, 10:00" / "09.07.2026 um 09:00 Uhr" → ISO.
 * Listing's data-sort always carries the date-only form; detail-page fields
 * occasionally include a time component too.
 */
export function parseAustrianDateTime(text: string | null | undefined): string | null {
  if (!text) return null
  const m = text.match(/(\d{2})\.(\d{2})\.(\d{4})(?:[,\s]+(?:um\s+)?(\d{1,2}):(\d{2}))?/)
  if (!m) return null
  const [, d, mo, y, hh, mm] = m
  if (hh && mm) return `${y}-${mo}-${d}T${hh.padStart(2, '0')}:${mm}:00`
  return `${y}-${mo}-${d}T00:00:00`
}

export function stripHtml(html: string | null | undefined): string {
  if (!html) return ''
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h\d|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#178;/g, '²')
    // &amp; must be decoded last — otherwise "&amp;lt;" would double-decode.
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** "DD.MM.YYYY" for the portal's `VVDat1`/`VVDat2` parameters. */
export function formatAtDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}.${mm}.${d.getFullYear()}`
}
