const MONTH_DE: Record<string, string> = {
  Januar: '01', Februar: '02', März: '03', Maerz: '03', April: '04', Mai: '05',
  Juni: '06', Juli: '07', August: '08', September: '09', Oktober: '10',
  November: '11', Dezember: '12',
}

export function parseGermanDateTime(text: string): string | null {
  // "Donnerstag, 07. Mai 2026, 10:00 Uhr"
  const m = text.match(/(\d{1,2})\.\s*(\p{L}+)\s+(\d{4}),?\s*(\d{1,2}):(\d{2})/u)
  if (!m) return null
  const [, d, monthName, y, hh, mm] = m
  const month = MONTH_DE[monthName]
  if (!month) return null
  return `${y}-${month}-${d.padStart(2, '0')}T${hh.padStart(2, '0')}:${mm}:00`
}

export function parseGermanTimestamp(text: string): string | null {
  // "28-04-2026 12:16"
  const m = text.match(/(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})/)
  if (!m) return null
  const [, d, mo, y, hh, mm] = m
  return `${y}-${mo}-${d}T${hh}:${mm}:00`
}

export function parseEuro(text: string): number | null {
  // "214.000,00 Euro" or "800.000,00" or "16.100,00&nbsp;"
  const m = text.replace(/\s|&nbsp;/g, '').match(/([\d.]+,\d{2})/)
  if (!m) return null
  const n = m[1].replace(/\./g, '').replace(',', '.')
  const num = parseFloat(n)
  return Number.isFinite(num) ? num : null
}

export function parseFileSize(text: string): number | null {
  const m = text.match(/([\d.,]+)\s*(kB|MB|KB|B)/i)
  if (!m) return null
  // The portal mixes formats: "1.234,56" (German thousands+decimal) and "188.25" (English decimal).
  // Heuristic: a comma marks the decimal; otherwise a single dot followed by 1-2 digits is the decimal.
  let s = m[1]
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.')
  } else if (/^\d+\.\d{1,2}$/.test(s)) {
    // already English-style decimal — keep as is
  } else {
    s = s.replace(/\./g, '')
  }
  const num = parseFloat(s)
  if (!Number.isFinite(num)) return null
  const unit = m[2].toLowerCase()
  if (unit === 'mb') return Math.round(num * 1024 * 1024)
  if (unit === 'kb') return Math.round(num * 1024)
  return Math.round(num)
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&auml;/g, 'ä').replace(/&ouml;/g, 'ö').replace(/&uuml;/g, 'ü')
    .replace(/&Auml;/g, 'Ä').replace(/&Ouml;/g, 'Ö').replace(/&Uuml;/g, 'Ü')
    .replace(/&szlig;/g, 'ß').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&sup2;/g, '²').replace(/&sup3;/g, '³').replace(/&deg;/g, '°')
    .replace(/&#128;/g, '€').replace(/&euro;/g, '€')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
}

// The ZVG-Portal serves a Latin-1 page but injects DB values that are sometimes
// already UTF-8 encoded. After Latin-1 decoding, those values look like "GÃ¶rlitz".
// This unscrambles the common cases.
export function fixMojibake(s: string): string {
  if (!/Ã[-¿]/.test(s)) return s
  return s
    .replace(/Ã¤/g, 'ä').replace(/Ã¶/g, 'ö').replace(/Ã¼/g, 'ü')
    .replace(/Ã„/g, 'Ä').replace(/Ã–/g, 'Ö').replace(/Ãœ/g, 'Ü')
    .replace(/ÃŸ/g, 'ß').replace(/Ã©/g, 'é').replace(/Ã¨/g, 'è')
    .replace(/Ã¡/g, 'á').replace(/Ã ¡/g, 'á')
}

export function clean(s: string): string {
  return fixMojibake(decodeEntities(s)).replace(/\s+/g, ' ').trim()
}
