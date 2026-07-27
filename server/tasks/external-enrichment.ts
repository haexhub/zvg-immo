import type { Auction, HazardAssessment, LandValueBaseline, MarketComparison } from '~/types/auction'
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
import {
  createEffisWildfireFileAdapter,
  DEFAULT_EFFIS_STATIC_RISK_MAX_CACHE_AGE_DAYS,
} from '~/server/utils/external-data/effis-wildfire'
import { createAvalancheDiscoveryAdapter } from '~/server/utils/external-data/avalanche'
import { cacheKey } from '~/server/utils/verkehrswert-cache'

export interface MarketComparisonAdapter {
  id: string
  sourceVersion: string
  minIntervalMs?: number
  supports(auction: Auction): boolean
  compare(auction: Auction): Promise<MarketComparison | null>
}

export interface LandValueBaselineAdapter {
  id: string
  sourceVersion: string
  minIntervalMs?: number
  supports(auction: Auction): boolean
  baseline(auction: Auction): Promise<LandValueBaseline | null>
}

export interface HazardAssessmentAdapter {
  id: string
  sourceVersion: string
  minIntervalMs?: number
  supports(auction: Auction): boolean
  assess(auction: Auction): Promise<HazardAssessment[]>
}

export interface ExternalEnrichmentOptions {
  marketAdapters?: MarketComparisonAdapter[]
  landValueAdapters?: LandValueBaselineAdapter[]
  hazardAdapters?: HazardAssessmentAdapter[]
  providerRateLimits?: Record<string, number>
  sleep?: (ms: number) => Promise<void>
  now?: Date
  limit?: number
}

export type ExternalEnrichmentProviderKind = 'market' | 'land_value' | 'hazard'

export interface ExternalEnrichmentProviderSummary {
  id: string
  kind: ExternalEnrichmentProviderKind
  sourceVersion: string
  supported: number
  attempted: number
  produced: number
  staleResults: number
  failures: number
  rateLimited: number
  waitedMs: number
  durationMs: number
}

export interface ExternalEnrichmentSummary {
  processed: number
  written: number
  skippedMissingCoordinates: number
  marketComparisons: number
  landValueBaselines: number
  hazards: number
  staleResults: number
  providerFailures: number
  providers: ExternalEnrichmentProviderSummary[]
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
    staleResults: 0,
    providerFailures: 0,
    providers: [],
    durationMs: 0,
  }

  const marketAdapters = options.marketAdapters ?? await defaultMarketAdapters()
  const landValueAdapters = options.landValueAdapters ?? []
  const hazardAdapters = options.hazardAdapters ?? await defaultHazardAdapters(checkedAt)
  const providerStats = new ProviderStatsTracker(summary.providers)
  const rateLimiter = new ProviderRateLimiter({
    rateLimits: options.providerRateLimits ?? defaultProviderRateLimits(),
    sleep: options.sleep ?? sleep,
  })

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

    const marketComparison = await firstMarketComparison(auction, marketAdapters, summary, providerStats, rateLimiter)
    const landValueBaseline = await firstLandValueBaseline(auction, landValueAdapters, summary, providerStats, rateLimiter)
    const hazards = await allHazards(auction, hazardAdapters, summary, providerStats, rateLimiter)

    if (marketComparison) summary.marketComparisons++
    if (landValueBaseline) summary.landValueBaselines++
    summary.hazards += hazards.length
    summary.staleResults += hazards.filter((hazard) => hazard.stale).length

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
  providerStats: ProviderStatsTracker,
  rateLimiter: ProviderRateLimiter,
): Promise<MarketComparison | null> {
  for (const adapter of adapters) {
    if (!adapter.supports(auction)) continue
    const stats = providerStats.forAdapter('market', adapter)
    stats.supported++
    try {
      await rateLimiter.wait('market', adapter, stats)
      stats.attempted++
      const startedAt = Date.now()
      const result = await adapter.compare(auction)
      stats.durationMs += Date.now() - startedAt
      if (result) {
        stats.produced++
        return result
      }
    } catch (err) {
      stats.failures++
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
  providerStats: ProviderStatsTracker,
  rateLimiter: ProviderRateLimiter,
): Promise<LandValueBaseline | null> {
  for (const adapter of adapters) {
    if (!adapter.supports(auction)) continue
    const stats = providerStats.forAdapter('land_value', adapter)
    stats.supported++
    try {
      await rateLimiter.wait('land_value', adapter, stats)
      stats.attempted++
      const startedAt = Date.now()
      const result = await adapter.baseline(auction)
      stats.durationMs += Date.now() - startedAt
      if (result) {
        stats.produced++
        return result
      }
    } catch (err) {
      stats.failures++
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
  providerStats: ProviderStatsTracker,
  rateLimiter: ProviderRateLimiter,
): Promise<HazardAssessment[]> {
  const out: HazardAssessment[] = []
  for (const adapter of adapters) {
    if (!adapter.supports(auction)) continue
    const stats = providerStats.forAdapter('hazard', adapter)
    stats.supported++
    try {
      await rateLimiter.wait('hazard', adapter, stats)
      stats.attempted++
      const startedAt = Date.now()
      const results = await adapter.assess(auction)
      stats.durationMs += Date.now() - startedAt
      stats.produced += results.length
      stats.staleResults += results.filter((hazard) => hazard.stale).length
      out.push(...results)
    } catch (err) {
      stats.failures++
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
      maxCacheAgeDays: numberConfig(config.euFloodRiskMaxCacheAgeDays, DEFAULT_EU_FLOOD_RISK_MAX_CACHE_AGE_DAYS),
    }))
  }
  if (config?.effisWildfireCachePath) {
    adapters.push(await createEffisWildfireFileAdapter({
      cachePath: config.effisWildfireCachePath,
      checkedAt,
      maxStaticRiskAgeDays: numberConfig(config.effisWildfireStaticRiskMaxCacheAgeDays, DEFAULT_EFFIS_STATIC_RISK_MAX_CACHE_AGE_DAYS),
      maxSampleDistanceMeters: numberConfig(config.effisWildfireMaxSampleDistanceMeters, 12_000),
    }))
  }
  if (config?.avalancheDiscoveryPath) {
    adapters.push(await createAvalancheDiscoveryAdapter({
      metadataPath: config.avalancheDiscoveryPath,
      checkedAt,
      maxCacheAgeDays: numberConfig(config.avalancheDiscoveryMaxCacheAgeDays, 400),
    }))
  }
  return adapters
}

interface ExternalDataRuntimeConfig {
  frDvfCachePath?: string
  euFloodRiskGeoJsonPath?: string
  euFloodRiskMaxCacheAgeDays?: number | string
  effisWildfireCachePath?: string
  effisWildfireStaticRiskMaxCacheAgeDays?: number | string
  effisWildfireMaxSampleDistanceMeters?: number | string
  avalancheDiscoveryPath?: string
  avalancheDiscoveryMaxCacheAgeDays?: number | string
  providerRateLimitsJson?: string
}

function numberConfig(value: number | string | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return fallback
}

function defaultProviderRateLimits(): Record<string, number> {
  if (typeof useRuntimeConfig !== 'function') return {}
  const config = useRuntimeConfig().externalData as ExternalDataRuntimeConfig | undefined
  return parseProviderRateLimits(config?.providerRateLimitsJson)
}

export function parseProviderRateLimits(input: string | undefined): Record<string, number> {
  if (!input?.trim()) return {}
  try {
    const parsed = JSON.parse(input) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (!/^[\w.:-]+$/.test(key)) continue
      const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
      if (Number.isFinite(number) && number >= 0) out[key] = Math.round(number)
    }
    return out
  } catch {
    return {}
  }
}

class ProviderStatsTracker {
  private readonly byKey = new Map<string, ExternalEnrichmentProviderSummary>()

  constructor(private readonly summaries: ExternalEnrichmentProviderSummary[]) {}

  forAdapter(
    kind: ExternalEnrichmentProviderKind,
    adapter: { id: string; sourceVersion: string },
  ): ExternalEnrichmentProviderSummary {
    const key = `${kind}:${adapter.id}`
    const existing = this.byKey.get(key)
    if (existing) return existing
    const summary: ExternalEnrichmentProviderSummary = {
      id: adapter.id,
      kind,
      sourceVersion: adapter.sourceVersion,
      supported: 0,
      attempted: 0,
      produced: 0,
      staleResults: 0,
      failures: 0,
      rateLimited: 0,
      waitedMs: 0,
      durationMs: 0,
    }
    this.byKey.set(key, summary)
    this.summaries.push(summary)
    return summary
  }
}

class ProviderRateLimiter {
  private readonly lastStartedAt = new Map<string, number>()
  private readonly rateLimits: Record<string, number>
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: { rateLimits: Record<string, number>; sleep: (ms: number) => Promise<void> }) {
    this.rateLimits = options.rateLimits
    this.sleep = options.sleep
  }

  async wait(
    kind: ExternalEnrichmentProviderKind,
    adapter: { id: string; minIntervalMs?: number },
    stats: ExternalEnrichmentProviderSummary,
  ): Promise<void> {
    const minIntervalMs = adapter.minIntervalMs ?? this.rateLimits[adapter.id] ?? this.rateLimits[`${kind}:${adapter.id}`] ?? 0
    if (minIntervalMs <= 0) {
      this.lastStartedAt.set(`${kind}:${adapter.id}`, Date.now())
      return
    }
    const key = `${kind}:${adapter.id}`
    const now = Date.now()
    const lastStartedAt = this.lastStartedAt.get(key)
    const waitMs = lastStartedAt == null ? 0 : Math.max(0, lastStartedAt + minIntervalMs - now)
    if (waitMs > 0) {
      stats.rateLimited++
      stats.waitedMs += waitMs
      await this.sleep(waitMs)
    }
    this.lastStartedAt.set(key, Date.now())
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
