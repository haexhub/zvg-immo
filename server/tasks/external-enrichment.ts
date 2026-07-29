import type { Auction, HazardAssessment, LandValueBaseline, LocationContext, MarketComparison } from '~/types/auction'
import { readAuctionSnapshot } from '~/server/utils/auction-snapshot'
import { geocodeAddress } from '~/server/utils/geocode'
import {
  readLocationEnrichmentCache,
  writeLocationEnrichmentCache,
  type LocationEnrichmentCache,
} from '~/server/utils/external-data/location-enrichment'
import { createDvfFileMarketAdapter } from '~/server/utils/external-data/fr-dvf-cache'
import {
  createEuFloodRiskFileAdapter,
  DEFAULT_EU_FLOOD_RISK_MAX_CACHE_AGE_DAYS,
} from '~/server/utils/external-data/eu-flood-risk'
import { createEeaEnvironmentalNoiseEnhancer } from '~/server/utils/external-data/eea-environmental-noise'
import { createOsmLocationContextAdapter } from '~/server/utils/external-data/osm-location-context'
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

export interface LocationContextAdapter {
  id: string
  sourceVersion: string
  supports(auction: Auction): boolean
  context(auction: Auction): Promise<LocationContext | null>
}

export interface LocationContextEnhancer {
  id: string
  sourceVersion: string
  supports(auction: Auction, context: LocationContext): boolean
  enhance(auction: Auction, context: LocationContext): Promise<LocationContext>
}

export interface ExternalEnrichmentOptions {
  marketAdapters?: MarketComparisonAdapter[]
  landValueAdapters?: LandValueBaselineAdapter[]
  hazardAdapters?: HazardAssessmentAdapter[]
  locationContextAdapters?: LocationContextAdapter[]
  now?: Date
  limit?: number
  country?: string
  platform?: string
  externalId?: string
}

export interface ExternalEnrichmentSummary {
  processed: number
  written: number
  skippedMissingCoordinates: number
  marketComparisons: number
  landValueBaselines: number
  hazards: number
  locationContexts: number
  staleResults: number
  providerFailures: number
  durationMs: number
}

let queueTail: Promise<void> = Promise.resolve()
let queuedRuns = 0

export default defineTask({
  meta: {
    name: 'external-enrichment',
    description: 'Refresh cached external market and natural-hazard overlays for auction detail pages.',
  },
  async run(event) {
    const options = (event?.payload ?? {}) as ExternalEnrichmentOptions
    const previous = queueTail
    let releaseQueue!: () => void
    queueTail = new Promise<void>((resolve) => { releaseQueue = resolve })
    if (queuedRuns > 0) {
      console.warn(`[external-enrichment] queued ${scopeLabel(options)} behind ${queuedRuns} active/pending run(s)`)
    }
    queuedRuns++
    try {
      await previous
      return { result: await runExternalEnrichment(options) }
    } finally {
      queuedRuns--
      releaseQueue()
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
    locationContexts: 0,
    staleResults: 0,
    providerFailures: 0,
    durationMs: 0,
  }

  const marketAdapters = options.marketAdapters ?? await defaultMarketAdapters()
  const landValueAdapters = options.landValueAdapters ?? []
  const hazardAdapters = options.hazardAdapters ?? await defaultHazardAdapters(checkedAt)
  const locationContextAdapters = options.locationContextAdapters ?? defaultLocationContextAdapters(checkedAt)

  for (const rawAuction of Object.values(snapshot).filter((auction) => inScope(auction, options))) {
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
    const locationContext = await firstLocationContext(auction, locationContextAdapters, summary)

    if (marketComparison) summary.marketComparisons++
    if (landValueBaseline) summary.landValueBaselines++
    summary.hazards += hazards.length
    if (locationContext) summary.locationContexts++
    summary.staleResults += hazards.filter((hazard) => hazard.stale).length

    if (!marketComparison && !landValueBaseline && hazards.length === 0 && !locationContext) continue

    entries[key] = {
      platform: auction.platform,
      externalId: auction.externalId,
      lat: point.lat,
      lng: point.lng,
      marketComparison: marketComparison ?? previous?.marketComparison ?? null,
      landValueBaseline: landValueBaseline ?? previous?.landValueBaseline ?? null,
      hazards: hazards.length > 0 ? hazards : previous?.hazards ?? null,
      locationContext: locationContext ?? previous?.locationContext ?? null,
      checkedAt,
      sourceVersion: sourceVersion([
        ...marketAdapters,
        ...landValueAdapters,
        ...hazardAdapters,
        ...locationContextAdapters,
      ]),
    }
  }

  const ok = await writeLocationEnrichmentCache(entries)
  summary.written = ok ? Object.keys(entries).length : 0
  summary.durationMs = Date.now() - startedAt
  return summary
}

function inScope(auction: Auction, options: ExternalEnrichmentOptions): boolean {
  if (options.country && auction.country.toLowerCase() !== options.country.trim().toLowerCase()) return false
  if (options.platform && auction.platform !== options.platform) return false
  if (options.externalId && auction.externalId !== options.externalId) return false
  return true
}

function scopeLabel(options: ExternalEnrichmentOptions): string {
  const parts = [
    options.country ? `country=${options.country}` : null,
    options.platform ? `platform=${options.platform}` : null,
    options.externalId ? `externalId=${options.externalId}` : null,
  ].filter((part): part is string => !!part)
  return parts.length > 0 ? parts.join(',') : 'full run'
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

async function firstLocationContext(
  auction: Auction,
  adapters: LocationContextAdapter[],
  summary: ExternalEnrichmentSummary,
): Promise<LocationContext | null> {
  for (const adapter of adapters) {
    if (!adapter.supports(auction)) continue
    try {
      const result = await adapter.context(auction)
      if (result) return result
    } catch (err) {
      summary.providerFailures++
      console.warn(`[external-enrichment] ${adapter.id} location context failed for ${auction.platform}/${auction.externalId}: ${(err as Error).message}`)
    }
  }
  return null
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
      maxCacheAgeDays: numberConfig(config.euFloodRiskMaxCacheAgeDays, DEFAULT_EU_FLOOD_RISK_MAX_CACHE_AGE_DAYS),
    }))
  }
  return adapters
}

function defaultLocationContextAdapters(checkedAt: string): LocationContextAdapter[] {
  if (typeof useRuntimeConfig !== 'function') return []
  const config = useRuntimeConfig().externalData as ExternalDataRuntimeConfig | undefined
  const endpoint = stringConfig(config?.osmContextEndpoint)
  if (!endpoint) return []
  const osmAdapter = createOsmLocationContextAdapter({
    endpoint,
    checkedAt,
    timeoutMs: numberConfig(config?.osmContextTimeoutMs, 20_000),
  })
  const enhancers: LocationContextEnhancer[] = []
  const eeaNoiseServiceBaseUrl = stringConfig(config?.eeaNoiseServiceBaseUrl)
  if (eeaNoiseServiceBaseUrl) {
    enhancers.push(createEeaEnvironmentalNoiseEnhancer({
      checkedAt,
      serviceBaseUrl: eeaNoiseServiceBaseUrl,
      timeoutMs: numberConfig(config?.eeaNoiseTimeoutMs, 10_000),
    }))
  }
  return [withLocationContextEnhancers(osmAdapter, enhancers)]
}

function withLocationContextEnhancers(
  adapter: LocationContextAdapter,
  enhancers: LocationContextEnhancer[],
): LocationContextAdapter {
  if (enhancers.length === 0) return adapter
  return {
    id: [adapter.id, ...enhancers.map((enhancer) => enhancer.id)].join('+'),
    sourceVersion: [adapter.sourceVersion, ...enhancers.map((enhancer) => enhancer.sourceVersion)].join(','),
    supports: (auction) => adapter.supports(auction),
    async context(auction) {
      let context = await adapter.context(auction)
      if (!context) return null
      for (const enhancer of enhancers) {
        if (!enhancer.supports(auction, context)) continue
        try {
          context = await enhancer.enhance(auction, context)
        } catch (err) {
          console.warn(`[external-enrichment] ${enhancer.id} location context enhancer failed for ${auction.platform}/${auction.externalId}: ${(err as Error).message}`)
        }
      }
      return context
    },
  }
}

interface ExternalDataRuntimeConfig {
  frDvfCachePath?: string
  euFloodRiskGeoJsonPath?: string
  euFloodRiskMaxCacheAgeDays?: number | string
  osmContextEndpoint?: string
  osmContextTimeoutMs?: number | string
  eeaNoiseServiceBaseUrl?: string
  eeaNoiseTimeoutMs?: number | string
}

function numberConfig(value: number | string | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return fallback
}

function stringConfig(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}
