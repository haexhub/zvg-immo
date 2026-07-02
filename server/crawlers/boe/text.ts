/** Decode common HTML numeric entities (e.g. `&#xC1;` → `Á`) plus a few
 *  named ones that appear on subastas.boe.es. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&euro;/g, '€')
    // &amp; must be decoded last — otherwise "&amp;lt;" would double-decode.
    .replace(/&amp;/g, '&')
}

export function clean(s: string): string {
  return decodeEntities(s).replace(/\s+/g, ' ').trim()
}

/** Parses Spanish-formatted Euro amounts like `88.029,53 €` → 88029.53. */
export function parseEuroEs(text: string): number | null {
  const m = decodeEntities(text).replace(/\s|&nbsp;/g, '').match(/([\d.]+,\d{2})/)
  if (!m?.[1]) return null
  const n = m[1].replace(/\./g, '').replace(',', '.')
  const num = parseFloat(n)
  return Number.isFinite(num) ? num : null
}

/** Parses BOE date strings of the form `25/05/2026 a las 18:00:00` (or with
 *  comma instead of "a las"). Returns ISO without timezone — the upstream
 *  is in CET; downstream consumers display in local time anyway. */
export function parseSpanishDateTime(text: string): string | null {
  const m = text.match(/(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})(?:\s*(?:a las|,)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (!m) return null
  const [, d = '', mo = '', y = '', hh, mm, ss] = m
  const day = d.padStart(2, '0')
  const mon = mo.padStart(2, '0')
  const time = hh ? `T${hh.padStart(2, '0')}:${mm}:${ss ?? '00'}` : 'T00:00:00'
  return `${y}-${mon}-${day}${time}`
}
