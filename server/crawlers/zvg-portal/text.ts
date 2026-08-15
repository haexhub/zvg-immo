import { aggregateMarketValue } from '~/server/utils/market-value-aggregation'

const MONTH_DE: Record<string, string> = {
  Januar: '01', Februar: '02', März: '03', Maerz: '03', April: '04', Mai: '05',
  Juni: '06', Juli: '07', August: '08', September: '09', Oktober: '10',
  November: '11', Dezember: '12',
}

export function parseGermanDateTime(text: string): string | null {
  // "Donnerstag, 07. Mai 2026, 10:00 Uhr"
  const m = text.match(/(\d{1,2})\.\s*(\p{L}+)\s+(\d{4}),?\s*(\d{1,2}):(\d{2})/u)
  if (!m) return null
  const [, d = '', monthName, y, hh = '', mm] = m
  if (!monthName) return null
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
  // Preserve portal block boundaries: they separate the individual lots from
  // an optional Gesamtwert. Removing whitespace here previously joined a
  // Grundbuchblatt number to the following amount.
  const lines = text
    .replace(/<\s*br\s*\/?\s*>|<\/(?:p|div|li|tr|td)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&euro;|&#128;/gi, '€')
    .replace(/&nbsp;/gi, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const valuesIn = (line: string): number[] => {
    const currencyAmount = /(?:^|[^\d.,])(\d{1,3}(?:\.\d{3})*(?:,\d+)?|\d+(?:,\d+)?)(?:\s*)(?:€|EUR\b|Euro\b)/gi
    const marked = [...line.matchAll(currencyAmount)].map((match) => match[1])
    // A euro marker is often present only in the table heading. Remove marked
    // amounts before parsing bare German-formatted values to avoid counting a
    // single amount twice.
    const unmarked = line.replace(currencyAmount, ' ')
    const bare = [...unmarked.matchAll(/\b(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+,\d{2})\b/g)]
      .map((match) => match[1])
    return [...marked, ...bare]
      .filter((amount): amount is string => amount != null)
      .map((amount) => parseFloat(amount.replace(/\./g, '').replace(',', '.')))
      .filter(Number.isFinite)
  }

  const explicitTotal = lines
    .filter((line) => /\b(?:gesamt(?:verkehrs)?wert|gesamtbetrag|gesamtsumme|verkehrswert\s+(?:gesamt|insgesamt))\b/i.test(line))
    .flatMap(valuesIn)
  if (explicitTotal.length > 0) return aggregateMarketValue([], Math.max(...explicitTotal))

  // Some listings phrase the aggregate as "X €, wobei auf die einzelnen
  // Parzellen entfallen …" instead of labelling it as a Gesamtwert.
  const proseTotal = lines.find((line) => /\bwobei\b.*\b(?:entfallen|aufgeteilt)\b/i.test(line))
  if (proseTotal) return aggregateMarketValue([], valuesIn(proseTotal)[0])

  return aggregateMarketValue(lines.flatMap(valuesIn))
}

export function parseFileSize(text: string): number | null {
  const m = text.match(/([\d.,]+)\s*(kB|MB|KB|B)/i)
  if (!m?.[1] || !m[2]) return null
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
  if (!s.includes('Ã')) return s
  return s
    .replace(/Ã¤/g, 'ä').replace(/Ã¶/g, 'ö').replace(/Ã¼/g, 'ü')
    .replace(/Ã„/g, 'Ä').replace(/Ã–/g, 'Ö').replace(/Ãœ/g, 'Ü')
    .replace(/ÃŸ/g, 'ß').replace(/Ã©/g, 'é').replace(/Ã¨/g, 'è')
    .replace(/Ã¡/g, 'á').replace(/Ã\u00a0/g, 'à') // Ã + NBSP = mojibake 'à'
}

export function clean(s: string): string {
  return fixMojibake(decodeEntities(s)).replace(/\s+/g, ' ').trim()
}
