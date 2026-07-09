/** "2026-07-09 12:59" → "2026-07-09" */
export function parseLtDate(raw: string): string | null {
  return raw.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null
}

/** " 39 168 Eur" → 39168 */
export function parseLtPrice(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, '')
  if (!digits) return null
  const n = parseInt(digits, 10)
  return Number.isFinite(n) ? n : null
}

export function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}
