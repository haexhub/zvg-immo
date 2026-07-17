/** "12.07.2026" or "12.07.2026 10:00" → "2026-07-12" */
export function parsePlDate(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/)
  if (!m) return null
  return `${m[3]!}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`
}

/** "250 000 zł" or "250 000,00 PLN" → 250000 */
export function parsePlPrice(s: string): number | null {
  // Strip currency symbol, then remove thousands separators (spaces,  )
  const normalised = s.replace(/[^0-9,\.]/g, '').replace(',', '.')
  const num = parseFloat(normalised)
  return isNaN(num) ? null : Math.round(num)
}

export function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Formats a PLN amount the way the old table column did: "130.000 zł". */
export function formatPln(pln: number): string {
  return `${pln.toLocaleString('de-DE', { maximumFractionDigits: 0 })} zł`
}

/** Extracts the usable floor area from a Polish notice text, e.g.
 *  "posiada powierzchnię użytkową 70,80 m kw" (all declensions) or
 *  "Powierzchnia lokalu mieszkalnego wynosi: 42,02 m2" → 70.8 / 42.02. */
export function parseLivingAreaSqm(text: string): number | null {
  const m =
    text.match(
      /powierzchni\p{L}*\s+użytkow\p{L}*\s*[:\-–]?\s*(?:wynosi\s+|wynoszącą\s+)?(\d[\d\s ]*(?:[,.]\d+)?)\s*m(?:\s*kw|²|2)/iu,
    ) ??
    text.match(
      /powierzchni\p{L}*\s+lokalu(?:\s+mieszkalnego)?\s+wynosi\s*[:\-–]?\s*(\d[\d\s ]*(?:[,.]\d+)?)\s*m(?:\s*kw|²|2)/iu,
    )
  if (!m) return null
  const num = parseFloat(m[1]!.replace(/[\s ]/g, '').replace(',', '.'))
  return isNaN(num) || num <= 0 ? null : num
}
