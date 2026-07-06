/** "12.07.2026" or "12.07.2026 10:00" → "2026-07-12" */
export function parsePlDate(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/)
  if (!m) return null
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
}

/** "250 000 zł" or "250 000,00 PLN" → 250000 */
export function parsePlPrice(s: string): number | null {
  // Strip currency symbol, then remove thousands separators (spaces,  )
  const normalised = s.replace(/[^0-9,\.]/g, '').replace(',', '.')
  const num = parseFloat(normalised)
  return isNaN(num) ? null : Math.round(num)
}

export function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}
