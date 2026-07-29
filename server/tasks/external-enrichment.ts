import type { Pool } from 'pg'
import type { Auction, HazardAssessment, LandValueBaseline, LocationContext, MarketComparison } from '~/types/auction'
import { readAuctionSnapshot } from '~/server/utils/auction-snapshot'
import { geocodeAddress } from '~/server/utils/geocode'
import { getPool } from '~/server/utils/db'
import {
  readLocationEnrichmentCache,
  writeLocationEnrichmentCache,
  type LocationEnrichmentCache,
} from '~/server/utils/external-data/location-enrichment'
import { createDvfFileMarketAdapter } from '~/server/utils/external-data/fr-dvf-cache'
import { createEuFloodRiskFileAdapter } from '~/server/utils/external-data/eu-flood-risk'
import { createEeaEnvironmentalNoiseEnhancer } from '~/server/utils/external-data/eea-environmental-noise'
import { createCamsAirQualityEnhancer } from '~/server/utils/external-data/cams-air-quality'
import { createOsmLocationContextAdapter } from '~/server/utils/external-data/osm-location-context'
import {
  getStoredExternalDataSourceConfig,
  getConfigurableExternalDataSource,
  resolveExternalDataSourceConfig,
  type ExternalDataSourceConfigValues,
} from '~/server/utils/external-data/config'
import { cacheKey } from '~/server/utils/verkehrswert-cache'
import { runExclusiveTask, throwIfTaskAborted } from '~/server/utils/exclusive-task'

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
  /** Concrete, user-displayable failures retained for partial runs. */
  errors: string[]
  durationMs: number
}

export default defineTask({
  meta: {
    name: 'external-enrichment',
    description: 'Refresh cached external market and natural-hazard overlays for auction detail pages.',
  },
  async run(event) {
    const options = (event?.payload ?? {}) as ExternalEnrichmentOptions
    return await runExclusiveTask('external-enrichment', async (signal) => ({
      result: await runExternalEnrichment(options, signal),
    }))
  },
})

export async function runExternalEnrichment(
  options: ExternalEnrichmentOptions = {},
  signal?: AbortSignal,
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
    errors: [],
    durationMs: 0,
  }

  const db = getPool()
  const marketAdapters = options.marketAdapters ?? await defaultMarketAdapters(db)
  const landValueAdapters = options.landValueAdapters ?? []
  const hazardAdapters = options.hazardAdapters ?? await defaultHazardAdapters(db, checkedAt, summary)
  const locationContextAdapters = options.locationContextAdapters ?? await defaultLocationContextAdapters(db, checkedAt)
  throwIfTaskAborted(signal)

  for (const rawAuction of Object.values(snapshot).filter((auction) => inScope(auction, options))) {
    throwIfTaskAborted(signal)
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
    throwIfTaskAborted(signal)
    const landValueBaseline = await firstLandValueBaseline(auction, landValueAdapters, summary)
    throwIfTaskAborted(signal)
    const hazards = await allHazards(auction, hazardAdapters, summary)
    throwIfTaskAborted(signal)
    const locationContext = await firstLocationContext(auction, locationContextAdapters, summary)
    throwIfTaskAborted(signal)

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

  throwIfTaskAborted(signal)
  const ok = await writeLocationEnrichmentCache(entries)
  throwIfTaskAborted(signal)
  summary.written = ok ? Object.keys(entries).length : 0
  if (!ok && Object.keys(entries).length > 0) {
    summary.errors.push('Externe Anreicherungsdaten konnten nicht gespeichert werden.')
  }
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
      recordProviderFailure(summary, adapter.id, 'market', auction, err)
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
      recordProviderFailure(summary, adapter.id, 'land baseline', auction, err)
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
      recordProviderFailure(summary, adapter.id, 'hazards', auction, err)
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
      recordProviderFailure(summary, adapter.id, 'location context', auction, err)
    }
  }
  return null
}

function recordProviderFailure(
  summary: ExternalEnrichmentSummary,
  adapterId: string,
  kind: string,
  auction: Auction,
  error: unknown,
): void {
  summary.providerFailures++
  const message = `${adapterId} ${kind} für ${auction.platform}/${auction.externalId}: ${
    error instanceof Error ? error.message : String(error)
  }`
  if (summary.errors.length < 100) summary.errors.push(message)
  console.warn(`[external-enrichment] ${message}`)
}

function sourceVersion(adapters: Array<{ id: string; sourceVersion: string }>): string {
  return adapters.length > 0
    ? adapters.map((adapter) => `${adapter.id}@${adapter.sourceVersion}`).join(',')
    : 'no-adapters'
}

// Every default*Adapters function below resolves its source(s) through this
// one path — DB override (app_settings, /settings) > env runtimeConfig
// (nuxt.config.ts's externalData.*) > the field's own default, exactly the
// generic contract server/utils/external-data/config.ts documents. A source
// with no configFields, or whose required fields resolve empty everywhere,
// yields `null` and is left out — same graceful-degrade as before, now
// driven by the registry instead of one hand-written check per source.
async function resolvedSourceValues(
  db: Pool | null,
  sourceId: string,
): Promise<ExternalDataSourceConfigValues | null> {
  const source = getConfigurableExternalDataSource(sourceId)
  if (!source) return null
  const stored = db ? await getStoredExternalDataSourceConfig(db, sourceId) : {}
  const runtimeConfig = typeof useRuntimeConfig === 'function'
    ? (useRuntimeConfig().externalData as Record<string, string | number | undefined> | undefined) ?? {}
    : {}
  const resolved = resolveExternalDataSourceConfig(source, stored, runtimeConfig)
  return resolved.isConfigured ? resolved.values : null
}

async function defaultMarketAdapters(db: Pool | null): Promise<MarketComparisonAdapter[]> {
  const adapters: MarketComparisonAdapter[] = []
  const values = await resolvedSourceValues(db, 'fr-dvf-geolocated')
  if (values) {
    adapters.push(await createDvfFileMarketAdapter({ cachePath: String(values.cachePath) }))
  }
  return adapters
}

async function defaultHazardAdapters(
  db: Pool | null,
  checkedAt: string,
  summary: ExternalEnrichmentSummary,
): Promise<HazardAssessmentAdapter[]> {
  const adapters: HazardAssessmentAdapter[] = []
  const values = await resolvedSourceValues(db, 'eu-flood-risk-areas')
  if (values) {
    // The polygon cache is filled out-of-band (server/tasks/import-eu-flood-
    // risk-cache.ts), so a path that was just set from /settings legitimately
    // points at a file that doesn't exist yet — and unlike fr-dvf's
    // readJsonCache, createEuFloodRiskFileAdapter reads it eagerly and throws
    // on ENOENT/corrupt JSON. Skip only this source instead of rejecting the
    // whole run. Retain the concrete configuration failure in the result so
    // the other providers can continue without hiding it from the admin.
    try {
      adapters.push(await createEuFloodRiskFileAdapter({
        geoJsonPath: String(values.geoJsonPath),
        checkedAt,
        maxCacheAgeDays: Number(values.maxCacheAgeDays),
      }))
    } catch (error) {
      summary.providerFailures++
      const message = `eu-flood-risk cache ${String(values.geoJsonPath)}: ${
        error instanceof Error ? error.message : String(error)
      }`
      summary.errors.push(message)
      console.warn(`[external-enrichment] ${message}`)
    }
  }
  return adapters
}

async function defaultLocationContextAdapters(db: Pool | null, checkedAt: string): Promise<LocationContextAdapter[]> {
  const osmValues = await resolvedSourceValues(db, 'openstreetmap-overpass')
  if (!osmValues) return []
  const osmAdapter = createOsmLocationContextAdapter({
    endpoint: String(osmValues.endpoint),
    checkedAt,
    timeoutMs: Number(osmValues.timeoutMs),
  })
  const enhancers: LocationContextEnhancer[] = []
  const eeaValues = await resolvedSourceValues(db, 'eea-environmental-noise-directive')
  if (eeaValues) {
    enhancers.push(createEeaEnvironmentalNoiseEnhancer({
      checkedAt,
      serviceBaseUrl: String(eeaValues.serviceBaseUrl),
      timeoutMs: Number(eeaValues.timeoutMs),
    }))
  }
  const airQualityValues = await resolvedSourceValues(db, 'cams-air-quality')
  if (airQualityValues) {
    enhancers.push(createCamsAirQualityEnhancer({
      checkedAt,
      serviceUrl: String(airQualityValues.serviceUrl),
      timeoutMs: Number(airQualityValues.timeoutMs),
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
        context = await enhancer.enhance(auction, context)
      }
      return context
    },
  }
}
