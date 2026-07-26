import type { Auction, HazardAssessment, LandValueBaseline, MarketComparison } from '~/types/auction'
import { readAuctionSnapshot } from '~/server/utils/auction-snapshot'
import { geocodeAddress } from '~/server/utils/geocode'
import {
  readLocationEnrichmentCache,
  writeLocationEnrichmentCache,
  type LocationEnrichmentCache,
} from '~/server/utils/external-data/location-enrichment'
import { createDvfFileMarketAdapter } from '~/server/utils/external-data/fr-dvf-cache'
import { createEuFloodRiskFileAdapter } from '~/server/utils/external-data/eu-flood-risk'
import { cacheKey } from '~/server/utils/verkehrswert-cache'

export interface MarketComparisonAdapter {
  id: string
  sourceVersion: string
  supports(auction: Auction): boolean
  compare(auction: Auction): Promise<MarketComparison | null>
}

export interface LandValueBaselineAdapter {
  id: string
  sourceVersion: string
  supports(auction: Auction): boolean
  baseline(auction: Auction): Promise<LandValueBaseline | null>
}

export interface HazardAssessmentAdapter {
  id: string
  sourceVersion: string
  supports(auction: Auction): boolean
  assess(auction: Auction): Promise<HazardAssessment[]>
}

export interface ExternalEnrichmentOptions {
  marketAdapters?: MarketComparisonAdapter[]
  landValueAdapters?: LandValueBaselineAdapter[]
  hazardAdapters?: HazardAssessmentAdapter[]
  now?: Date
  limit?: number
}

export interface ExternalEnrichmentSummary {
  processed: number
  written: number
  skippedMissingCoordinates: number
  marketComparisons: number
  landValueBaselines: number
  hazards: number
  providerFailures: number
  durationMs: number
}

let running = false

export default defineTask({
  meta: {
    name: 'external-enrichment',
    description: 'Refresh cached external market and natural-hazard overlays for auction detail pages.',
  },
  async run() {
    if (running) {
      console.warn('[external-enrichment] previous run still in progress — skipping')
      return { result: undefined }
    }
    running = true
    try {
      return { result: await runExternalEnrichment() }
    } finally {
      running = false
    }
  },
})

export async function runExternalEnrichment(
  options: ExternalEnrichmentOptions = {},
): Promise<ExternalEnrichmentSummary> {
  const startedAt = Date.now()
  const now = options.now ?? new Date()
  const checkedAt = now.toISOString()
  const snapshot = await readAuctionSnapshot()
  const existing = await readLocationEnrichmentCache()
  const entries: LocationEnrichmentCache = {}
  const summary: ExternalEnrichmentSummary = {
    processed: 0,
    written: 0,
    skippedMissingCoordinates: 0,
    marketComparisons: 0,
    landValueBaselines: 0,
    hazards: 0,
    providerFailures: 0,
    durationMs: 0,
  }

  const marketAdapters = options.marketAdapters ?? await defaultMarketAdapters()
  const landValueAdapters = options.landValueAdapters ?? []
  const hazardAdapters = options.hazardAdapters ?? await defaultHazardAdapters(checkedAt)

  for (const rawAuction of Object.values(snapshot)) {
    if (options.limit != null && summary.processed >= options.limit) break
    const point = await resolvePoint(rawAuction)
    if (!point) {
      summary.skippedMissingCoordinates++
      continue
    }
    const auction: Auction = { ...rawAuction, lat: point.lat, lng: point.lng }
    summary.processed++
    const key = cacheKey(auction.platform, auction.externalId)
    const previous = existing[key]

    const marketComparison = await firstMarketComparison(auction, marketAdapters, summary)
    const landValueBaseline = await firstLandValueBaseline(auction, landValueAdapters, summary)
    const hazards = await allHazards(auction, hazardAdapters, summary)

    if (marketComparison) summary.marketComparisons++
    if (landValueBaseline) summary.landValueBaselines++
    summary.hazards += hazards.length

    if (!marketComparison && !landValueBaseline && hazards.length === 0) continue

    entries[key] = {
      platform: auction.platform,
      externalId: auction.externalId,
      lat: point.lat,
      lng: point.lng,
      marketComparison: marketComparison ?? previous?.marketComparison ?? null,
      landValueBaseline: landValueBaseline ?? previous?.landValueBaseline ?? null,
      hazards: hazards.length > 0 ? hazards : previous?.hazards ?? null,
      checkedAt,
      sourceVersion: sourceVersion([
        ...marketAdapters,
        ...landValueAdapters,
        ...hazardAdapters,
      ]),
    }
  }

  const ok = await writeLocationEnrichmentCache(entries)
  summary.written = ok ? Object.keys(entries).length : 0
  summary.durationMs = Date.now() - startedAt
  return summary
}

async function resolvePoint(auction: Auction): Promise<{ lat: number; lng: number } | null> {
  if (auction.lat != null && auction.lng != null) {
    return { lat: auction.lat, lng: auction.lng }
  }
  const point = await geocodeAddress(auction.address, auction.country, { fetchMissing: false })
  return point ? { lat: point.lat, lng: point.lng } : null
}

async function firstMarketComparison(
  auction: Auction,
  adapters: MarketComparisonAdapter[],
  summary: ExternalEnrichmentSummary,
): Promise<MarketComparison | null> {
  for (const adapter of adapters) {
    if (!adapter.supports(auction)) continue
    try {
      const result = await adapter.compare(auction)
      if (result) return result
    } catch (err) {
      summary.providerFailures++
      console.warn(`[external-enrichment] ${adapter.id} market failed for ${auction.platform}/${auction.externalId}: ${(err as Error).message}`)
    }
  }
  return null
}

async function firstLandValueBaseline(
  auction: Auction,
  adapters: LandValueBaselineAdapter[],
  summary: ExternalEnrichmentSummary,
): Promise<LandValueBaseline | null> {
  for (const adapter of adapters) {
    if (!adapter.supports(auction)) continue
    try {
      const result = await adapter.baseline(auction)
      if (result) return result
    } catch (err) {
      summary.providerFailures++
      console.warn(`[external-enrichment] ${adapter.id} land baseline failed for ${auction.platform}/${auction.externalId}: ${(err as Error).message}`)
    }
  }
  return null
}

async function allHazards(
  auction: Auction,
  adapters: HazardAssessmentAdapter[],
  summary: ExternalEnrichmentSummary,
): Promise<HazardAssessment[]> {
  const out: HazardAssessment[] = []
  for (const adapter of adapters) {
    if (!adapter.supports(auction)) continue
    try {
      out.push(...await adapter.assess(auction))
    } catch (err) {
      summary.providerFailures++
      console.warn(`[external-enrichment] ${adapter.id} hazards failed for ${auction.platform}/${auction.externalId}: ${(err as Error).message}`)
    }
  }
  return out
}

function sourceVersion(adapters: Array<{ id: string; sourceVersion: string }>): string {
  return adapters.length > 0
    ? adapters.map((adapter) => `${adapter.id}@${adapter.sourceVersion}`).join(',')
    : 'no-adapters'
}

async function defaultMarketAdapters(): Promise<MarketComparisonAdapter[]> {
  if (typeof useRuntimeConfig !== 'function') return []
  const config = useRuntimeConfig().externalData as ExternalDataRuntimeConfig | undefined
  const adapters: MarketComparisonAdapter[] = []
  if (config?.frDvfCachePath) {
    adapters.push(await createDvfFileMarketAdapter({ cachePath: config.frDvfCachePath }))
  }
  return adapters
}

async function defaultHazardAdapters(checkedAt: string): Promise<HazardAssessmentAdapter[]> {
  if (typeof useRuntimeConfig !== 'function') return []
  const config = useRuntimeConfig().externalData as ExternalDataRuntimeConfig | undefined
  const adapters: HazardAssessmentAdapter[] = []
  if (config?.euFloodRiskGeoJsonPath) {
    adapters.push(await createEuFloodRiskFileAdapter({
      geoJsonPath: config.euFloodRiskGeoJsonPath,
      checkedAt,
    }))
  }
  return adapters
}

interface ExternalDataRuntimeConfig {
  frDvfCachePath?: string
  euFloodRiskGeoJsonPath?: string
}
