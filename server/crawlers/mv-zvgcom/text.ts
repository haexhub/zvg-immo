/** "28.08.2026" + "10:00" -> { iso: "2026-08-28T10:00:00", label: "28.08.2026, 10:00 Uhr" } */
export function parseMvDateTime(
  date: string | null | undefined,
  time: string | null | undefined,
): { iso: string | null; label: string | null } {
  const m = date?.match(/(\d{2})\.(\d{2})\.(\d{4})/)
  if (!m) return { iso: null, label: null }
  const [, d, mo, y] = m
  const tm = time?.match(/(\d{1,2}):(\d{2})/)
  const hh = tm ? tm[1]!.padStart(2, '0') : '00'
  const mm = tm ? tm[2]! : '00'
  return {
    iso: `${y}-${mo}-${d}T${hh}:${mm}:00`,
    label: `${d}.${mo}.${y}${tm ? `, ${hh}:${mm} Uhr` : ''}`,
  }
}

/** The API's title is "<Aktenzeichen>: <Objektbeschreibung>" — strip the
 *  redundant leading case number so `title` isn't a duplicate of `caseNumber`. */
export function stripAzPrefix(title: string, az: string): string {
  const prefix = `${az}:`
  return title.startsWith(prefix) ? title.slice(prefix.length).trim() : title.trim()
}

/** The grid's `vwert` is 0 for some auctions although the getText free text
 *  carries "Verkehrswert: 75.500,00 €". Multi-lot auctions (Einzelausgebote)
 *  list one value per lot with no overall figure, so a value is only returned
 *  when exactly one distinct amount appears in the text. */
export function extractSingleVerkehrswert(
  text: string,
): { eur: number; text: string } | null {
  const matches = [...text.matchAll(/Verkehrswert:?\s*([\d.]+(?:,\d+)?)\s*€/gi)].map(
    (m) => m[1]!,
  )
  // Compare parsed values, not raw strings — the same amount may appear twice
  // with different formatting ("75.500" vs "75.500,00").
  const distinct = [...new Set(matches.map((m) => parseFloat(m.replace(/\./g, '').replace(',', '.'))))]
  if (distinct.length !== 1) return null
  const eur = distinct[0]!
  if (!Number.isFinite(eur) || eur <= 0) return null
  return { eur, text: `${matches[0]} €` }
}

/** getText's response is a single `<div class="divHTML">...</div>` blob of
 *  loosely-closed HTML (<br>, <U>, <B>, <Font Color=red>). Strip tags, keep
 *  line breaks. The API already serves proper UTF-8 (no HTML entities seen in
 *  practice), so no entity decoding is needed here. */
export function stripDivHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
