/**
 * Resolves the market value of one auction that may contain several parts.
 * A source-provided total is authoritative; otherwise every supplied part
 * belongs to the same auction and is added together.
 */
export function aggregateMarketValue(
  parts: readonly (number | null | undefined)[],
  explicitTotal: number | null | undefined = null,
): number | null {
  if (isPositiveFinite(explicitTotal)) return explicitTotal

  const sum = parts
    .filter(isPositiveFinite)
    .reduce((total, value) => total + value, 0)
  return isPositiveFinite(sum) ? sum : null
}

interface ParsedAggregate {
  value: number
  partCount: number
  hasExplicitTotal: boolean
}

/**
 * Applies the aggregate-value rule to a crawler's raw market-value text.
 * This is deliberately independent of a portal: crawlers that expose one
 * scalar value remain unchanged, while a single auction with multiple listed
 * values receives the stated total or the sum of its parts.
 */
export function applyMarketValueTextAggregation(auction: Auction): void {
  const parsed = parseMarketValueAggregate(auction.marketValueText)
  if (!parsed || (!parsed.hasExplicitTotal && parsed.partCount < 2)) return

  auction.marketValue = parsed.value
  if (auction.currency == null || auction.currency === 'EUR') {
    auction.currency = 'EUR'
    auction.marketValueEur = parsed.value
  }
}

function parseMarketValueAggregate(text: string | null): ParsedAggregate | null {
  if (!text) return null
  const candidates = monetaryCandidates(text)
  if (candidates.length === 0) return null

  const totalLabel = /\b(?:gesamt(?:verkehrs)?wert|gesamtbetrag|gesamtsumme|verkehrswert\s+(?:gesamt|insgesamt)|total(?:e|en)?|total(?: amount| value)?|sum(?:me|ma|total)?|samanlagt|kokku|összes(?:en)?|celkem|ukupno|razem)\b/gi
  const labelledTotal = [...text.matchAll(totalLabel)]
    .map((match) => candidates.find((candidate) => candidate.index >= (match.index ?? 0))?.value)
    .find((value): value is number => value != null)

  const value = aggregateMarketValue(candidates.map((candidate) => candidate.value), labelledTotal)
  return value == null
    ? null
    : { value, partCount: candidates.length, hasExplicitTotal: labelledTotal != null }
}

function monetaryCandidates(text: string): Array<{ index: number; value: number }> {
  const candidates: Array<{ index: number; value: number }> = []
  const add = (raw: string | undefined, index: number | undefined) => {
    if (!raw || index == null || candidates.some((candidate) => candidate.index === index)) return
    const value = parseLocaleAmount(raw)
    if (value != null) candidates.push({ index, value })
  }

  // Formatted figures are safe even when a portal prints the currency only in
  // the table heading; plain integers require an adjacent currency marker.
  for (const match of text.matchAll(/\b(\d{1,3}(?:[ ,.\u00a0]\d{3})+(?:[,.]\d+)?|\d+[,.]\d{2})\b/g)) {
    add(match[1], match.index)
  }
  for (const match of text.matchAll(/(?:€|£)\s*(\d+)(?![.,]\d)/g)) {
    add(match[1], (match.index ?? 0) + match[0].indexOf(match[1]!))
  }
  for (const match of text.matchAll(/(?<![\d.,])(\d+)(?:\s*:-?)?\s*(?:€|£|EUR\b|GBP\b|SEK\b|DKK\b|NOK\b|CZK\b|Kč\b|HUF\b|Ft\b|PLN\b|zł\b|BAM\b|KM\b|CAD\b)/gi)) {
    add(match[1], match.index)
  }
  return candidates.sort((a, b) => a.index - b.index)
}

function parseLocaleAmount(raw: string): number | null {
  let value = raw.replace(/[ \u00a0]/g, '')
  const commaCount = (value.match(/,/g) ?? []).length
  const dotCount = (value.match(/\./g) ?? []).length
  if (commaCount > 0 && dotCount > 0) {
    if (value.lastIndexOf(',') > value.lastIndexOf('.')) value = value.replace(/\./g, '').replace(',', '.')
    else value = value.replace(/,/g, '')
  } else if (commaCount > 0) {
    value = commaCount > 1 && /(?:,\d{3})+$/.test(value) ? value.replace(/,/g, '') : value.replace(',', '.')
  } else if (dotCount > 0 && /(?:\.\d{3})+$/.test(value)) {
    value = value.replace(/\./g, '')
  }
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0
}
import type { Auction } from '~/types/auction'
