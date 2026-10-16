import { parseAreaValue } from '~/server/utils/extract/sizes'

export function parseEuro(text: string | null | undefined): number | null {
  if (!text) return null
  // "130.000,00 €" / "1.234,56 EUR" — German formatting; some lines look like
  // "siehe Gutachten" with no number, those must return null.
  const m = text.match(/([\d.]+(?:,\d+)?)\s*(?:€|EUR)/i)
  if (!m?.[1]) return null
  const normalized = m[1].replace(/\./g, '').replace(',', '.')
  const value = parseFloat(normalized)
  return Number.isFinite(value) ? value : null
}

/** "63 m²" / "179.95 m²" / "1.438 m²" — the detail facts mix dot-decimal
 *  ("179.95") with German thousands-dot ("1.438") formats. Delegates to the
 *  central area parser so the locale heuristics live in one place. */
export function parseSqm(text: string | null | undefined): number | null {
  if (!text) return null
  const value = parseAreaValue(text)
  return value != null && value > 0 ? value : null
}

export function parseGermanDateTimeString(text: string | null | undefined): string | null {
  if (!text) return null
  // "19.05.2026, 10:00 Uhr" — list view's `auctionDate` string.
  const m = text.match(/(\d{2})\.(\d{2})\.(\d{4})\s*,?\s*(\d{1,2}):(\d{2})/)
  if (!m) return null
  const [, d, mo, y, hh = '', mm] = m
  return `${y}-${mo}-${d}T${hh.padStart(2, '0')}:${mm}:00`
}

export function stripHtml(html: string | null | undefined): string {
  if (!html) return ''
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h\d|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // &amp; must be decoded last — otherwise "&amp;lt;" would double-decode.
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Extracts the Inertia.js page payload from an HTML response. The whole app
 * state lives in `<div id="app" data-page="…json-encoded…">`, so we never need
 * to scrape the rendered DOM.
 */
export function extractInertiaPage<T = unknown>(html: string): T | null {
  const m = html.match(/data-page="([^"]+)"/)
  if (!m?.[1]) return null
  // The attribute is HTML-entity encoded; decode the small set Laravel/Inertia
  // actually emits.
  const decoded = m[1]
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // &amp; must be decoded last — otherwise "&amp;lt;" would double-decode.
    .replace(/&amp;/g, '&')
    // zvbawü occasionally emits a literal \u0000 JSON escape mid-word
    // in free-text fields (confirmed live, e.g. titles splitting like
    // "Gr\u0000ünflä\u0000che") — an upstream encoding bug. Stripped here,
    // before JSON.parse, since the escape would otherwise decode into a
    // real NUL byte that Postgres rejects on write.
    .replace(/\\u0000/gi, '')
  try {
    return JSON.parse(decoded) as T
  } catch {
    return null
  }
}
