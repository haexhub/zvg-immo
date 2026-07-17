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

/** Detail-page "Bendras turto plotas" values → m².
 *  "10,68 kv. m" → 10.68 | "13 a. (0,13 ha.)" → 1300 ("a" = Ar = 100 m²) |
 *  "2,5 ha" → 25000. */
export function parseLtArea(raw: string): number | null {
  const num = (s: string) => parseFloat(s.replace(',', '.'))
  const kv = raw.match(/(\d+(?:[.,]\d+)?)\s*kv\.?\s*m/i)
  if (kv?.[1]) return num(kv[1])
  const ar = raw.match(/(\d+(?:[.,]\d+)?)\s*a\b/i)
  if (ar?.[1]) return num(ar[1]) * 100
  const ha = raw.match(/(\d+(?:[.,]\d+)?)\s*ha\b/i)
  if (ha?.[1]) return num(ha[1]) * 10_000
  return null
}
