export function clean(s: string | null | undefined): string | null {
  if (!s) return null
  const trimmed = s.replace(/\s+/g, ' ').trim()
  return trimmed || null
}

/** "2026-07-21T14:30:00" (no timezone suffix, already local) -> ISO + German label. */
export function parsePtDateTime(raw: string | null | undefined): { iso: string | null; label: string | null } {
  if (!raw) return { iso: null, label: null }
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  if (!m) return { iso: null, label: null }
  const [, y, mo, d, h, mi] = m
  return { iso: `${y}-${mo}-${d}T${h}:${mi}:00`, label: `${d}.${mo}.${y}, ${h}:${mi} Uhr` }
}

export function parsePtPrice(raw: number | null | undefined): number | null {
  return raw != null && raw > 0 ? raw : null
}

export function formatPtPrice(value: number | null): string | null {
  return value != null ? `${value.toLocaleString('de-DE', { maximumFractionDigits: 0 })} €` : null
}
