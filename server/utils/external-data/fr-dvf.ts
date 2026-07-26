import type { Auction, MarketComparison, MarketComparisonPropertyClass } from '~/types/auction'
import { calculateAuctionPricePerSqm, classifyMarketPropertyClass } from './market'
import { distanceMeters } from './geo'
import { percentile } from './statistics'
import { EXTERNAL_DATA_SOURCES } from './sources'

export interface RawDvfRow {
  id_mutation?: string
  date_mutation?: string
  valeur_fonciere?: string | number | null
  code_commune?: string | null
  commune?: string | null
  type_local?: string | null
  surface_reelle_bati?: string | number | null
  surface_terrain?: string | number | null
  latitude?: string | number | null
  longitude?: string | number | null
}

export interface DvfTransaction {
  id: string
  date: string | null
  lat: number
  lng: number
  communeCode: string | null
  communeName: string | null
  propertyClass: MarketComparisonPropertyClass
  priceEur: number
  builtAreaSqm: number | null
  landAreaSqm: number | null
}

export interface DvfMarketComparisonOptions {
  radiusMeters?: number
  minSamples?: number
  similarBandPct?: number
}

const DEFAULT_RADIUS_METERS = 10_000
// DVF contains transaction-level public records. Use an intentionally higher
// floor than the UI's generic display threshold to avoid tiny cohorts.
const DEFAULT_MIN_SAMPLES = 11
const DEFAULT_SIMILAR_BAND_PCT = 10

const DVF_SOURCE = EXTERNAL_DATA_SOURCES.find((source) => source.id === 'fr-dvf-geolocated')!

export function normalizeDvfRow(row: RawDvfRow): DvfTransaction | null {
  const priceEur = parseFrenchNumber(row.valeur_fonciere)
  const lat = parseFrenchNumber(row.latitude)
  const lng = parseFrenchNumber(row.longitude)
  if (priceEur == null || priceEur <= 0 || lat == null || lng == null) return null

  return {
    id: String(row.id_mutation ?? `${row.code_commune ?? 'unknown'}:${row.date_mutation ?? 'unknown'}:${priceEur}`),
    date: row.date_mutation ?? null,
    lat,
    lng,
    communeCode: row.code_commune ?? null,
    communeName: row.commune ?? null,
    propertyClass: classifyDvfPropertyClass(row.type_local),
    priceEur,
    builtAreaSqm: positiveOrNull(parseFrenchNumber(row.surface_reelle_bati)),
    landAreaSqm: positiveOrNull(parseFrenchNumber(row.surface_terrain)),
  }
}

export function buildDvfMarketComparison(
  auction: Auction,
  transactions: DvfTransaction[],
  options: DvfMarketComparisonOptions = {},
): MarketComparison | null {
  if (auction.country !== 'fr') return null
  if (auction.lat == null || auction.lng == null) return null

  const own = calculateAuctionPricePerSqm(auction)
  if (!own) return null

  const propertyClass = classifyMarketPropertyClass(auction)
  if (propertyClass === 'unknown' || propertyClass === 'mixed') return insufficient(own, auction.region, propertyClass)

  const radiusMeters = options.radiusMeters ?? DEFAULT_RADIUS_METERS
  const comparablePrices = transactions
    .filter((tx) => tx.propertyClass === propertyClass)
    .filter((tx) => distanceMeters({ lat: auction.lat!, lng: auction.lng! }, tx) <= radiusMeters)
    .map((tx) => pricePerSqmForBasis(tx, own.basis))
    .filter((value): value is number => value != null)

  const samples = comparablePrices.length
  const minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES
  if (samples < minSamples) {
    return { ...insufficient(own, auction.region, propertyClass), samples }
  }

  const medianPricePerSqm = percentile(comparablePrices, 0.5)
  const deltaPctVsMedian = medianPricePerSqm == null
    ? null
    : ((own.pricePerSqm - medianPricePerSqm) / medianPricePerSqm) * 100
  const band = options.similarBandPct ?? DEFAULT_SIMILAR_BAND_PCT
  const verdict =
    deltaPctVsMedian == null
      ? 'insufficient_data'
      : deltaPctVsMedian <= -band
        ? 'cheaper'
        : deltaPctVsMedian >= band
          ? 'more_expensive'
          : 'similar'

  return {
    ...own,
    regionLabel: regionLabel(auction, transactions),
    propertyClass,
    medianPricePerSqm,
    p25PricePerSqm: percentile(comparablePrices, 0.25),
    p75PricePerSqm: percentile(comparablePrices, 0.75),
    deltaPctVsMedian,
    verdict,
    samples,
    sources: [{
      id: DVF_SOURCE.id,
      label: DVF_SOURCE.label,
      url: DVF_SOURCE.sourceUrl,
      licenseNote: DVF_SOURCE.licenseNote,
    }],
  }
}

function insufficient(
  own: NonNullable<ReturnType<typeof calculateAuctionPricePerSqm>>,
  fallbackRegion: string,
  propertyClass: MarketComparisonPropertyClass,
): MarketComparison {
  return {
    ...own,
    regionLabel: fallbackRegion || 'France',
    propertyClass,
    medianPricePerSqm: null,
    p25PricePerSqm: null,
    p75PricePerSqm: null,
    deltaPctVsMedian: null,
    verdict: 'insufficient_data',
    samples: 0,
    sources: [{
      id: DVF_SOURCE.id,
      label: DVF_SOURCE.label,
      url: DVF_SOURCE.sourceUrl,
      licenseNote: DVF_SOURCE.licenseNote,
    }],
  }
}

function pricePerSqmForBasis(tx: DvfTransaction, basis: 'livingArea' | 'landArea'): number | null {
  const area = basis === 'livingArea' ? tx.builtAreaSqm : tx.landAreaSqm
  return area != null && area > 0 ? tx.priceEur / area : null
}

function classifyDvfPropertyClass(typeLocal: string | null | undefined): MarketComparisonPropertyClass {
  const normalized = (typeLocal ?? '').trim().toLowerCase()
  if (normalized === 'maison') return 'house'
  if (normalized === 'appartement') return 'apartment'
  if (normalized === 'terrain') return 'land'
  return 'unknown'
}

function parseFrenchNumber(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\s/g, '').replace(',', '.')
  if (!normalized) return null
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function positiveOrNull(value: number | null): number | null {
  return value != null && value > 0 ? value : null
}

function regionLabel(auction: Auction, transactions: DvfTransaction[]): string {
  const nearest = transactions
    .filter((tx) => tx.communeName)
    .map((tx) => ({
      label: tx.communeName!,
      distance: auction.lat != null && auction.lng != null
        ? distanceMeters({ lat: auction.lat, lng: auction.lng }, tx)
        : Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => a.distance - b.distance)[0]
  return nearest?.label ?? (auction.region || 'France')
}
