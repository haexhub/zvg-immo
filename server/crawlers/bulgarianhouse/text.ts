import { BASE_URL } from './constants'

export function clean(text: string): string {
  return text.replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim()
}

export function absoluteUrl(path: string): string {
  if (path.startsWith('http')) return path
  // Protocol-relative photo URLs ("//www.bulgarianhouse.com/photos/...").
  if (path.startsWith('//')) return `https:${path}`
  return `${BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`
}

/** Every number on this site (prices, sq. m. areas) is a plain integer with
 *  no thousands separator (verified live: "€13000", "220000 EUR", "2000 sq.
 *  m."), so taking the first run of digits is safe regardless of magnitude.
 *  Deliberately NOT "strip everything but digits and parse the remainder" —
 *  the m² unit is a literal "<sup>2</sup>" in the source markup, so its text
 *  reads as "108 m2": stripping non-digits would concatenate that trailing
 *  "2" onto the real number (108 → 1082). Matching only the first digit run
 *  stops at the "m" instead. Returns null for "0 m²" (an apartment's absent
 *  garden/plot), matching every other crawler's convention that a
 *  source-provided zero-area reading means "field not applicable", not
 *  "verified zero". */
export function parseNumber(text: string | null | undefined): number | null {
  if (!text) return null
  const match = text.match(/\d+/)
  if (!match) return null
  const n = Number(match[0])
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Splits the detail page's "Location: <Town> (<Oblast>)" feature line
 * (verified live on both apartments and rural houses, e.g. "Karnobat
 * (Burgas)", "Dobrich (Dobrich)" when town and oblast share a name) into its
 * two parts. Returns null when the line doesn't match — callers keep
 * whatever list.ts already set (the card's own oblast-only region name).
 */
export function parseLocation(text: string): { town: string; oblast: string } | null {
  const match = clean(text).match(/^(.+?)\s*\(([^)]+)\)$/)
  if (!match) return null
  const town = match[1]!.trim()
  const oblast = match[2]!.trim()
  return town && oblast ? { town, oblast } : null
}
