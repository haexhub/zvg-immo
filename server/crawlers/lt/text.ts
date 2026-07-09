/** "2026-07-09 12:59" → "2026-07-09" */
export function parseLtDate(raw: string): string | null {
  return raw.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null
}

/** " 39 168 Eur" → 39168 | "39 168,50 Eur" → 39169 */
export function parseLtPrice(raw: string): number | null {
  const normalised = raw.replace(/[^\d,\.]/g, '').replace(',', '.')
  const n = parseFloat(normalised)
  return isNaN(n) ? null : Math.round(n)
}

export function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}
