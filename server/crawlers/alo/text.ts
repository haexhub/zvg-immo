import { BASE_URL, ROOM_COUNT_BY_PREFIX } from './constants'

export function absoluteUrl(path: string): string {
  return path.startsWith('http') ? path : `${BASE_URL}/${path.replace(/^\/+/, '')}`
}

export function clean(s: string | null | undefined): string | null {
  const t = s?.replace(/\s+/g, ' ').trim()
  return t && t.length > 0 ? t : null
}

/** Same as `clean`, but keeps line breaks instead of collapsing them to a
 *  space — used for the detail page's full description, whose paragraph
 *  structure (already converted to "\n" on a cheerio clone) would otherwise
 *  run every line together. Only collapses horizontal whitespace and
 *  blank-line runs. */
export function cleanMultiline(s: string | null | undefined): string | null {
  const t = s
    ?.replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return t && t.length > 0 ? t : null
}

/** "210 332 €" / "210 332 €" (cheerio decodes &nbsp; to a literal NBSP,
 *  which \s already matches) → 210332. Bulgaria joined the Eurozone on
 *  2026-01-01 — every price on the site is already EUR-native, no БГН/EUR
 *  dual quote or conversion to handle. */
export function parsePrice(raw: string | null | undefined): number | null {
  if (!raw) return null
  const n = parseFloat(raw.replace(/\s/g, '').replace(/€$/, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

export function formatPrice(value: number | null): string | null {
  return value != null ? `${value.toLocaleString('de-DE', { maximumFractionDigits: 0 })} €` : null
}

/** Extracts the leading "<number> кв.м" out of a field that may carry a
 *  trailing label suffix (houses' "РЗП" field reads "63 кв.м РЗП", not just
 *  "63 кв.м" like apartments' "Квадратура"/"Двор" fields). */
export function parseAreaSqm(raw: string | null | undefined): number | null {
  if (!raw) return null
  const m = raw.match(/([\d][\d\s]*(?:[.,]\d+)?)\s*кв\.?м/i)
  if (!m) return null
  const n = parseFloat(m[1]!.replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : null
}

/** "Тристаен апартамент в София" → 3. Only apartments carry a "Вид на
 *  имота" field with a room-count adjective prefix; houses' "Етажност"
 *  field describes floor count, not room count, and is never fed here. */
export function parseRoomCount(propertyType: string | null | undefined): number | null {
  if (!propertyType) return null
  const prefix = propertyType.trim().toLowerCase().split(/\s+/)[0]
  return prefix ? (ROOM_COUNT_BY_PREFIX[prefix] ?? null) : null
}

/** The list/detail card's own address line ("Левски В, София" / "Банкя,
 *  област  София") is already comma-joined by the site — this only cleans
 *  whitespace and appends the country, same convention as every other BG
 *  crawler's address builder. */
export function buildAddress(raw: string | null | undefined): string | null {
  const address = clean(raw)
  return address ? `${address}, Bulgarien` : null
}

/** The detail page's "Виж на картата" link points at a plain Google Maps
 *  URL with the listing's own precise coordinates in its `q=` param
 *  (`https://maps.google.com/?q=<lat>,<lng>&...`) — verified live to be
 *  per-object, unlike e.g. kip.net's page-wide fixed city pin. */
export function extractLatLng(mapsHref: string | null | undefined): { lat: number | null; lng: number | null } {
  const m = mapsHref?.match(/[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)
  if (!m) return { lat: null, lng: null }
  return { lat: parseFloat(m[1]!), lng: parseFloat(m[2]!) }
}
