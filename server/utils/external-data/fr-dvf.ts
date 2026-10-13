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
  id_parcelle?: string | null
  lot1_numero?: string | null
  nature_culture?: string | null
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

export const DEFAULT_DVF_RADIUS_METERS = 10_000
// DVF contains transaction-level public records. Use an intentionally higher
// floor than the UI's generic display threshold to avoid tiny cohorts.
const DEFAULT_MIN_SAMPLES = 11
const DEFAULT_SIMILAR_BAND_PCT = 10

const DVF_SOURCE = EXTERNAL_DATA_SOURCES.find((source) => source.id === 'fr-dvf-geolocated')!

/**
 * DVF has one row per mutation x parcel x local (x land-use type), and
 * `valeur_fonciere` is the whole mutation's price repeated on every row. One
 * mutation is therefore one sample: its price once, divided by the summed area
 * of its distinct locals/parcels. Counting rows instead turned a 12-flat
 * building sale into 12 samples at 12x the real price per m², and alone met
 * the anti-reidentification sample floor.
 * ponytail: locals are told apart by parcel + first lot number + type +
 * surface; two identical lot-less locals on one parcel collapse into one.
 */
export function normalizeDvfMutation(rows: RawDvfRow[]): DvfTransaction | null {
  const first = rows[0]
  if (!first) return null
  const priceEur = parseFrenchNumber(first.valeur_fonciere)
  const located = rows.find((row) => parseFrenchNumber(row.latitude) != null && parseFrenchNumber(row.longitude) != null)
  const lat = parseFrenchNumber(located?.latitude)
  const lng = parseFrenchNumber(located?.longitude)
  if (priceEur == null || priceEur <= 0 || lat == null || lng == null) return null

  const classes = new Set<MarketComparisonPropertyClass>()
  const builtAreas = new Map<string, number>()
  const landAreas = new Map<string, number>()
  let hasLocal = false
  for (const row of rows) {
    if (row.type_local?.trim()) hasLocal = true
    const localClass = classifyDvfLocal(row.type_local)
    const builtArea = positiveOrNull(parseFrenchNumber(row.surface_reelle_bati))
    if (localClass) {
      classes.add(localClass)
      if (builtArea != null) builtAreas.set([row.id_parcelle, row.lot1_numero, row.type_local, builtArea].join('|'), builtArea)
    }
    const landArea = positiveOrNull(parseFrenchNumber(row.surface_terrain))
    if (landArea != null) landAreas.set(`${row.id_parcelle ?? ''}|${row.nature_culture ?? ''}`, landArea)
  }
  // DVF has no 'Terrain' local: a pure land sale leaves type_local empty on
  // every row and states the land use in nature_culture. A lone dependency
  // (garage, cellar) also has no class but is not land.
  if (classes.size === 0 && !hasLocal && landAreas.size > 0 && rows.some((row) => row.nature_culture?.trim())) {
    classes.add('land')
  }
  // Mixed sales (house + flat, or with commercial premises) have no single
  // comparable price per m².
  const [propertyClass] = classes
  if (classes.size !== 1 || !propertyClass || propertyClass === 'unknown') return null

  return {
    id: String(first.id_mutation ?? `${first.code_commune ?? 'unknown'}:${first.date_mutation ?? 'unknown'}:${priceEur}`),
    date: first.date_mutation ?? null,
    lat,
    lng,
    communeCode: first.code_commune ?? null,
    communeName: first.commune ?? null,
    propertyClass,
    priceEur,
    builtAreaSqm: positiveOrNull([...builtAreas.values()].reduce((total, area) => total + area, 0)),
    landAreaSqm: positiveOrNull([...landAreas.values()].reduce((total, area) => total + area, 0)),
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

  const radiusMeters = options.radiusMeters ?? DEFAULT_DVF_RADIUS_METERS
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

/** null = no local on this row, or a dependency (garage, cellar) that is sold
 *  along with a home and neither changes its class nor adds living area. */
function classifyDvfLocal(typeLocal: string | null | undefined): MarketComparisonPropertyClass | null {
  const normalized = (typeLocal ?? '').trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
  if (!normalized || normalized === 'dependance') return null
  if (normalized === 'maison') return 'house'
  if (normalized === 'appartement') return 'apartment'
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
