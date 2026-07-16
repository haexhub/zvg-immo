export function clean(s: string | null | undefined): string | null {
  const t = s?.replace(/\s+/g, ' ').trim()
  return t && t.length > 0 ? t : null
}

/** "22/07/2026 10:00" → { iso: "2026-07-22T10:00:00", label: "22.07.2026, 10:00 Uhr" } */
export function parseGrDateTime(
  raw: string | null | undefined,
): { iso: string | null; label: string | null } {
  if (!raw) return { iso: null, label: null }
  const m = raw.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/)
  if (!m) return { iso: null, label: null }
  const [, d, mo, y, hh, mm] = m
  return {
    iso: `${y}-${mo}-${d}T${hh}:${mm}:00`,
    label: `${d}.${mo}.${y}, ${hh}:${mm} Uhr`,
  }
}

export function parseGrPrice(raw: number | null | undefined): number | null {
  return raw != null && raw > 0 ? raw : null
}

export function formatGrPrice(value: number | null): string | null {
  return value != null ? `${value.toLocaleString('de-DE', { maximumFractionDigits: 0 })} €` : null
}
