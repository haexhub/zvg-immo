import type { Auction, MarketComparisonPropertyClass } from '~/types/auction'

export interface PricePerSqmInput {
  marketValueEur: number | null | undefined
  livingAreaSqm: number | null | undefined
  landAreaSqm: number | null | undefined
}

export interface PricePerSqmResult {
  pricePerSqm: number
  basis: 'livingArea' | 'landArea'
  areaSqm: number
}

export function calculatePricePerSqm(input: PricePerSqmInput): PricePerSqmResult | null {
  const marketValueEur = positiveNumberOrNull(input.marketValueEur)
  if (marketValueEur == null) return null

  const livingAreaSqm = positiveNumberOrNull(input.livingAreaSqm)
  if (livingAreaSqm != null) {
    return { pricePerSqm: marketValueEur / livingAreaSqm, basis: 'livingArea', areaSqm: livingAreaSqm }
  }

  const landAreaSqm = positiveNumberOrNull(input.landAreaSqm)
  if (landAreaSqm != null) {
    return { pricePerSqm: marketValueEur / landAreaSqm, basis: 'landArea', areaSqm: landAreaSqm }
  }

  return null
}

export function calculateAuctionPricePerSqm(auction: Auction): PricePerSqmResult | null {
  return calculatePricePerSqm({
    marketValueEur: auction.marketValueEur,
    livingAreaSqm: auction.extraction?.livingAreaSqm ?? auction.sourceLivingAreaSqm,
    landAreaSqm: auction.extraction?.landAreaSqm ?? auction.sourceLandAreaSqm,
  })
}

export function classifyMarketPropertyClass(auction: Auction): MarketComparisonPropertyClass {
  const propertyType = auction.extraction?.propertyType
  switch (propertyType) {
    case 'einfamilienhaus':
    case 'zweifamilienhaus':
    case 'mehrfamilienhaus':
    case 'doppelhaushaelfte':
    case 'reihenhaus':
      return 'house'
    case 'eigentumswohnung':
      return 'apartment'
    case 'land-forst':
    case 'unbebaut':
      return 'land'
    case 'wohn-geschaefts':
      return 'mixed'
    default:
      return 'unknown'
  }
}

function positiveNumberOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}
