import { LAND_TITLE_KEYWORDS, NON_PROPERTY_TITLES, ROOM_COUNT_BY_PREFIX } from './constants'

export function clean(s: string | null | undefined): string | null {
  const t = s?.replace(/\s+/g, ' ').trim()
  return t && t.length > 0 ? t : null
}

/** Same as `clean`, but keeps line breaks instead of collapsing them to a
 *  space — used for the "ОПИСАНИЕ" field, whose paragraph/`<br>` structure
 *  (already converted to "\n" on a cheerio clone) would otherwise run every
 *  line together. Only collapses horizontal whitespace and blank-line runs. */
export function cleanMultiline(s: string | null | undefined): string | null {
  const t = s
    ?.replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return t && t.length > 0 ? t : null
}

/** "92 480.00 EUR" / "92 480.00 EUR" (cheerio decodes &nbsp; to a
 *  literal NBSP, which \s already matches) → 92480. The portal shows this EUR
 *  figure as the primary price (a "лв." conversion is the secondary one), so
 *  no currency field/conversion is needed, same as bg/zapori. */
export function parsePrice(raw: string | null | undefined): number | null {
  if (!raw) return null
  const n = parseFloat(raw.replace(/\s/g, '').replace(/eur$/i, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

export function formatPrice(value: number | null): string | null {
  return value != null ? `${value.toLocaleString('de-DE', { maximumFractionDigits: 0 })} €` : null
}

/** "52 558.00 кв.м" → 52558. */
export function parseAreaSqm(raw: string | null | undefined): number | null {
  if (!raw) return null
  const n = parseFloat(raw.replace(/\s/g, '').replace(/кв\.?м\.?/i, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

/** "от 01.09.2026 до 01.10.2026" / plain "02.10.2026 10:00" → the first
 *  DD.MM.YYYY[ HH:MM] found. Output is a naive local-time ISO string with no
 *  offset/Z (same convention as si/pl's text.ts — the source publishes
 *  Bulgarian wall-clock time, not a timezone-aware timestamp). */
export function parseDateTime(raw: string | null | undefined): { iso: string | null; label: string | null } {
  if (!raw) return { iso: null, label: null }
  const m = raw.match(/(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?/)
  if (!m) return { iso: null, label: null }
  const [, d, mo, y, h, mi] = m
  const iso = `${y}-${mo}-${d}T${h ?? '00'}:${mi ?? '00'}:00`
  const label = h ? `${d}.${mo}.${y}, ${h}:${mi} Uhr` : `${d}.${mo}.${y}`
  return { iso, label }
}

export function isLandTitle(title: string | null): boolean {
  if (!title) return false
  const t = title.toLowerCase()
  return LAND_TITLE_KEYWORDS.some((kw) => t.includes(kw))
}

/** A small number of listings on this otherwise real-estate-only portal are
 *  vehicles or generic bulk-asset lots (verified live: 1 of 1173 sampled). */
export function isNonPropertyTitle(title: string | null): boolean {
  if (!title) return false
  const t = title.toLowerCase().trim()
  return NON_PROPERTY_TITLES.some((kw) => t === kw)
}

/** "Двустаен апартамент" → 2. Non-matching titles (houses, land, commercial
 *  lots, "Многостаен" = unspecified multi-room) stay null. */
export function parseRoomCount(title: string | null): number | null {
  if (!title) return null
  const prefix = title.trim().toLowerCase().split(/\s+/)[0]
  return prefix ? (ROOM_COUNT_BY_PREFIX[prefix] ?? null) : null
}

/** НАСЕЛЕНО МЯСТО (settlement) + Адрес (street/quarter, not always given) →
 *  one line, richest part first — same "no structured address" situation as
 *  bg/text.ts's parseBgAddress, except this portal names the settlement
 *  directly instead of requiring it to be regexed out of free text. */
export function buildAddress(settlement: string | null, street: string | null): string | null {
  const parts = [street, settlement].filter((p): p is string => Boolean(p))
  return parts.length > 0 ? `${parts.join(', ')}, Bulgarien` : null
}
