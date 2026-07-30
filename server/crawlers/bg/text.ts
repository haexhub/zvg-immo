export function clean(s: string | null | undefined): string | null {
  const t = s?.replace(/\s+/g, ' ').trim()
  return t && t.length > 0 ? t : null
}

/** Strips the announcement's inline HTML down to plain text, keeping
 *  paragraph breaks. Bulgarian notices use &bdquo;/&ldquo; as a low-high
 *  quote pair (e.g. &bdquo;Иван Вазов&ldquo;) rather than matched "" — both
 *  are decoded to a plain double quote since only tag/entity removal matters
 *  here, not typographic fidelity. */
export function stripBgHtml(html: string | null | undefined): string {
  if (!html) return ''
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&bdquo;|&ldquo;|&rdquo;|&quot;/gi, '"')
    .replace(/&ndash;/gi, '–')
    .replace(/&frac12;/gi, '1/2')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function parseBgPrice(raw: number | null | undefined): number | null {
  if (raw == null) return null
  return raw > 0 ? raw : null
}

export function formatBgPrice(value: number | null): string | null {
  return value != null ? `${value.toLocaleString('de-DE', { maximumFractionDigits: 0 })} €` : null
}

/** The API returns genuine UTC timestamps ("2026-09-17T06:00:00Z") — unlike
 *  some other platforms' mislabeled local time, these convert correctly via
 *  Europe/Sofia. */
export function formatBgDateText(iso: string | null | undefined): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const formatted = date.toLocaleString('de-DE', {
    timeZone: 'Europe/Sofia',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  return `${formatted} Uhr`
}

const SETTLEMENT_RE = /(гр\.|град|с\.|село)\s*([А-Я][А-Яа-я]+(?:[\s-][А-Я][А-Яа-я]+){0,2})/
// "ул." (street), "бул." (boulevard) or "кв." (quarter — older Bulgarian
// addresses number buildings within a kvartal instead of along a street).
const STREET_RE = /(ул|бул|кв)\.\s*"?([^"\n,]{2,60}?)"?\s*№\s*(\d+[a-zA-Zа-яА-Я]?)/
const MUNICIPALITY_RE = /община\s+([А-Я][А-Яа-я]+(?:[\s-][А-Я][А-Яа-я]+){0,2})/
const PROVINCE_RE = /област\s+([А-Я][А-Яа-я]+(?:[\s-][А-Я][А-Яа-я]+){0,2})/
const LOCALITY_RE = /местност\s+"?([^",.;–-]{2,60})"?/

/** Bulgaria's e-auction API never publishes a structured address — only the
 *  free-text title/description, which usually (but not always) names the
 *  settlement ("гр./с. NAME") and sometimes the street/quarter
 *  ("ул./бул./кв. „NAME" № N"). Returns null rather than guessing when
 *  neither pattern matches. */
export function parseBgAddress(title: string | null, description: string | null): string | null {
  const combined = `${title ?? ''}. ${description ?? ''}`
  const street = combined.match(STREET_RE)
  const settlement = combined.match(SETTLEMENT_RE)
  const municipality = combined.match(MUNICIPALITY_RE)
  const province = combined.match(PROVINCE_RE)
  const locality = combined.match(LOCALITY_RE)
  const parts: string[] = []
  if (street) parts.push(`${street[1]}. ${street[2]!.trim()} № ${street[3]}`)
  if (locality) parts.push(`местност ${locality[1]!.trim()}`)
  if (settlement) parts.push(`${settlement[1]} ${settlement[2]}`)
  if (municipality) parts.push(`община ${municipality[1]}`)
  if (province) parts.push(`област ${province[1]}`)
  return parts.length > 0 ? `${parts.join(', ')}, Bulgarien` : null
}
