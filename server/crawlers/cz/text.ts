/** "2026-07-07T07:00:00.000+00:00" → "2026-07-07" */
export function parseCzDate(s: string | null | undefined): string | null {
  if (!s) return null
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/)
  return m?.[1] ?? null
}

/** Raw CZK number from JSON → integer */
export function parseCzPrice(n: unknown): number | null {
  if (typeof n !== 'number' || !isFinite(n)) return null
  return Math.round(n)
}

export function clean(s: string | null | undefined): string {
  if (!s) return ''
  return s.replace(/\s+/g, ' ').trim()
}
