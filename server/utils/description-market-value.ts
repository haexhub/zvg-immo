import type { Auction } from '~/types/auction'

/**
 * Extracts an explicitly labelled EUR Verkehrswert from source prose.
 *
 * A single Auction can contain several separately described lots. When no
 * explicit overall value is published, their component values are added. An
 * explicitly labelled Gesamtverkehrswert always wins.
 */
export function extractDescriptionMarketValue(
  text: string,
): { eur: number; text: string } | null {
  const total = text.match(
    /(?:Gesamtverkehrswert|Verkehrswert\s+(?:insgesamt|gesamt))\s*:?\s*([\d.]+(?:,\d+)?)\s*€/i,
  )
  if (total?.[1]) {
    const eur = parseGermanEuro(total[1])
    return eur == null ? null : { eur, text: `${total[1]} €` }
  }

  const rawMatches = [...text.matchAll(/\bVerkehrswert(?:e)?\s*:?\s*([\d.]+(?:,\d+)?)\s*€/gi)]
    .map((m) => m[1]!)
  if (rawMatches.length === 0) return null

  const parsed = rawMatches
    .map((raw) => ({ raw, value: parseGermanEuro(raw) }))
    .filter((m): m is { raw: string; value: number } => m.value != null)
  if (parsed.length === 0) return null

  // Count at most one value per clearly separated property section. This
  // still adds two equally valued lots, while avoiding a duplicated sentence
  // inside one section being counted twice.
  const sectionPatterns = [
    /(?=Grundstück\s+eingetragen\s+im\s+Grundbuch)/gi,
    /(?=(?:^|\n)\s*Gemarkung\b[^\n]*\bFlurstück\b)/gim,
    /(?=(?:^|\n)\s*Flurstück\b)/gim,
  ]
  let sectionValues: number[] = []
  for (const pattern of sectionPatterns) {
    const sections = text.split(pattern).filter((section) => section.trim())
    const values = sections
      .map((section) => section.match(/\bVerkehrswert(?:e)?\s*:?\s*([\d.]+(?:,\d+)?)\s*€/i)?.[1])
      .map((raw) => raw ? parseGermanEuro(raw) : null)
      .filter((value): value is number => value != null)
    if (values.length >= 2) {
      sectionValues = values
      break
    }
  }
  const values = sectionValues.length >= 2
    ? sectionValues
    : [...new Set(parsed.map((m) => m.value))]
  const eur = values.reduce((sum, value) => sum + value, 0)
  if (!Number.isFinite(eur) || eur <= 0) return null

  if (values.length === 1) return { eur, text: `${parsed[0]!.raw} €` }
  return {
    eur,
    text: `${eur.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} € (Summe aus ${values.length} Teilwerten)`,
  }
}

/**
 * Fills a missing EUR value directly from the source description. Structured
 * crawler values always retain precedence.
 */
export function applyDescriptionMarketValue(auction: Auction): void {
  if (
    auction.marketValueEur != null ||
    auction.currency != null ||
    !auction.description
  ) return
  const extracted = extractDescriptionMarketValue(auction.description)
  if (!extracted) return
  auction.marketValueEur = extracted.eur
  auction.marketValueText = extracted.text
}

/** Parses a positive German-formatted amount without guessing other formats. */
function parseGermanEuro(raw: string): number | null {
  const value = Number.parseFloat(raw.replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(value) && value > 0 ? value : null
}
