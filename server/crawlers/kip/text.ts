import type { Auction } from '~/types/auction'
import { BASE_URL } from './constants'

export function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function absoluteUrl(url: string): string {
  if (url.startsWith('http')) return url
  // Image/gallery URLs on this site are protocol-relative ("//media...").
  if (url.startsWith('//')) return `https:${url}`
  return `${BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`
}

/**
 * Parses German-formatted numbers ("349.000,00 €", "150,00 m²", "5"). '.' is
 * always a thousands separator and ',' the decimal separator on this site, so
 * stripping '.' before swapping ',' for '.' works regardless of magnitude —
 * same convention every other DE-formatted crawler in this project relies on.
 */
export function parseGermanNumber(text: string | null | undefined): number | null {
  if (!text) return null
  const cleaned = text.replace(/[^\d.,]/g, '')
  if (!cleaned) return null
  const n = Number(cleaned.replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Applies the site's structured "Kaufpreis"/"Wohnfläche"/"Zimmer"/"Grundstück"
 * key-value facts (shared markup on both the list card and the detail page's
 * info boxes) onto an Auction. Label spelling varies slightly between the two
 * templates ("Wohnfläche" vs. "Wohnfläche (ca.)", "Grundstück" vs.
 * "Grundstücksgröße" — both verified live), so each field checks both. Only
 * ever overwrites when a value was actually found, so a later call (e.g.
 * detail.ts refining what list.ts already set) can't blank out a good value
 * with a missing one.
 */
export function applyAreaFacts(auction: Auction, facts: ReadonlyMap<string, string>): void {
  const livingAreaSqm = parseGermanNumber(facts.get('Wohnfläche') ?? facts.get('Wohnfläche (ca.)'))
  if (livingAreaSqm != null) auction.sourceLivingAreaSqm = livingAreaSqm

  const landAreaSqm = parseGermanNumber(facts.get('Grundstück') ?? facts.get('Grundstücksgröße'))
  if (landAreaSqm != null) auction.sourceLandAreaSqm = landAreaSqm

  const rooms = parseGermanNumber(facts.get('Zimmer'))
  if (rooms != null) auction.sourceRooms = rooms

  const priceText = facts.get('Kaufpreis')
  const price = parseGermanNumber(priceText)
  if (price != null) {
    auction.marketValueEur = price
    auction.marketValueText = priceText ?? null
  }
}
