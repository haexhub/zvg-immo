export function clean(s: string | null | undefined): string | null {
  if (!s) return null
  const trimmed = s.replace(/\s+/g, ' ').trim()
  return trimmed || null
}

/** The API returns UTC-suffixed timestamps ("...T10:45:00Z") that are actually
 *  the wall-clock auction time (Slovenia local), not real UTC — dropping the
 *  Z and keeping the literal digits avoids double-shifting the hour. */
export function parseSiDateTime(raw: string | null | undefined): { iso: string | null; label: string | null } {
  if (!raw) return { iso: null, label: null }
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  if (!m) return { iso: null, label: null }
  const [, y, mo, d, h, mi] = m
  return { iso: `${y}-${mo}-${d}T${h}:${mi}:00`, label: `${d}.${mo}.${y}, ${h}:${mi} Uhr` }
}

export function parseSiPrice(raw: string | number | null | undefined): number | null {
  if (raw == null) return null
  const n = typeof raw === 'number' ? raw : parseFloat(raw)
  return isNaN(n) || n <= 0 ? null : n
}

export function formatSiPrice(value: number | null): string | null {
  return value != null ? `${value.toLocaleString('de-DE', { maximumFractionDigits: 0 })} €` : null
}

/** roomsRelation valueContent like "2-sobno" → 2. Non-numeric categories
 *  ("Garsonjera") and half-room variants ("1,5-sobno") stay null. */
export function parseSiRooms(content: string | null | undefined): number | null {
  const m = content?.match(/^(\d+)-sobno$/)
  return m ? parseInt(m[1]!, 10) : null
}

/** Coordinate strings from address.latitude/longitude ("46.076706") → number. */
export function parseSiCoord(raw: string | null | undefined): number | null {
  if (!raw) return null
  const n = parseFloat(raw)
  return Number.isFinite(n) ? n : null
}
