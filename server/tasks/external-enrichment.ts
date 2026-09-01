import type { Auction, HazardAssessment, LandValueBaseline, LocationContext, MarketComparison } from '~/types/auction'
import { readAuctionRecord, readAuctionRecords } from '~/server/utils/auction-record'
import { geocodeAddress } from '~/server/utils/geocode'
import { getPool } from '~/server/utils/db'
import {
  readLocationEnrichmentCache,
  writeLocationEnrichmentCache,
} from '~/server/utils/external-data/location-enrichment'
import { cacheKey } from '~/server/utils/verkehrswert-cache'
import { runExclusiveTask, throwIfTaskAborted } from '~/server/utils/exclusive-task'
import { recordTaskRunEnd, recordTaskRunProgress, recordTaskRunStart, type TaskRunSummary } from '~/server/utils/task-runs'
import { inScope, orderByStaleness } from './external-enrichment-scope'
import {
  defaultHazardAdapters,
  defaultLocationContextAdapters,
  defaultMarketAdapters,
  recordProviderFailure,
} from './external-enrichment-adapters'

export { withLocationContextEnhancers } from './external-enrichment-adapters'

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
  context(auction: Auction, previous?: LocationContext | null): Promise<LocationContext | null>
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
  /** Restrict the run to the local OpenStreetMap location-context adapter. */
  osmOnly?: boolean
  /** Skip auctions that already have an OpenStreetMap location context. */
  onlyMissingLocationContext?: boolean
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
    return await runExclusiveTask('external-enrichment', async (signal) => {
      // Recorded because /settings triggers this detached: without a persisted
      // status a provider failure would vanish with the promise.
      await recordTaskRunStart('external-enrichment')
      try {
        const result = await runExternalEnrichment(options, signal)
        const { errors, ...summary } = result
        await recordTaskRunEnd('external-enrichment', {
          result: summary,
          warning: errors.length > 0
            ? `${errors.length} Fehler: ${errors.slice(0, 20).join('; ')}`
            : null,
        })
        return { result }
      } catch (err) {
        await recordTaskRunEnd('external-enrichment', { error: (err as Error).message })
        throw err
      }
    })
  },
})

// Caps every invocation (cron or manual trigger) to a batch instead of a
// full sweep, which measured ~16h — long enough that the next colliding
// runExclusiveTask abort costs a whole day's progress, not a batch's.
const DEFAULT_BATCH_LIMIT = 40

/**
 * Refreshes external enrichment for a bounded batch or one explicitly selected
 * auction when both platform and externalId are provided.
 */
export async function runExternalEnrichment(
  options: ExternalEnrichmentOptions = {},
  signal?: AbortSignal,
): Promise<ExternalEnrichmentSummary> {
  const startedAt = Date.now()
  const now = options.now ?? new Date()
  const checkedAt = now.toISOString()
  // A single-auction trigger (e.g. re-enrichment after coordinates moved,
  // see current-auctions.ts) only ever needs that one row — reading the full
  // table just to filter it back down to one auction in inScope() below
  // meant every such trigger joined and sorted the entire auctions/
  // auction_details/auction_fetch_state tables, which under concurrent crawl
  // load queued up on the shared pool and blew its 15s query_timeout.
  const records = options.platform && options.externalId
    ? await readAuctionRecord(options.platform, options.externalId).then((record) => record ? [record] : [])
    : await readAuctionRecords(options.country, { includePhotos: false })
  const existing = await readLocationEnrichmentCache()
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
  const marketAdapters = options.osmOnly ? [] : options.marketAdapters ?? await defaultMarketAdapters(db)
  const landValueAdapters = options.osmOnly ? [] : options.landValueAdapters ?? []
  const hazardAdapters = options.osmOnly ? [] : options.hazardAdapters ?? await defaultHazardAdapters(db, checkedAt, summary)
  const locationContextAdapters = options.locationContextAdapters ?? await defaultLocationContextAdapters(db, checkedAt, summary)
  throwIfTaskAborted(signal)

  const inScopeAuctions = records.map((record) => record.auction).filter((auction) =>
    inScope(auction, options)
    && (!options.onlyMissingLocationContext || existing[cacheKey(auction.platform, auction.externalId)]?.locationContext?.source.id !== 'openstreetmap-overpass'),
  )
  const effectiveLimit = options.limit ?? DEFAULT_BATCH_LIMIT
  // Sliced to the limit up front: resolvePoint below skips (not counts)
  // auctions without coordinates, so looping the unsliced scope and relying
  // only on the processed>=effectiveLimit break could still scan arbitrarily
  // far past the intended batch size.
  const batch = orderByStaleness(inScopeAuctions, existing).slice(0, effectiveLimit)
  const total = batch.length

  for (const rawAuction of batch) {
    throwIfTaskAborted(signal)
    if (summary.processed >= effectiveLimit) break
    try {
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
      const locationContext = await firstLocationContext(auction, locationContextAdapters, summary, previous?.locationContext ?? null)
      throwIfTaskAborted(signal)

      if (marketComparison) summary.marketComparisons++
      if (landValueBaseline) summary.landValueBaselines++
      summary.hazards += hazards.length
      if (locationContext) summary.locationContexts++
      summary.staleResults += hazards.filter((hazard) => hazard.stale).length

      // No early-exit when every adapter came back empty: that's the common,
      // correct outcome for rural/small-town ZVG objects, not an error, and
      // skipping the write would skip checkedAt too — leaving the auction
      // stuck at the front of orderByStaleness forever, starving others.

      // Written immediately, per auction, instead of batched into one write
      // after the whole scope finishes: a full sweep can run for a long time
      // and gets superseded (aborted) whenever a newer external-enrichment
      // invocation starts (runExclusiveTask) — with continuous background
      // crawling that happens often, and a batch-at-the-end write meant every
      // auction's freshly-computed result was thrown away with it, no matter
      // how far the run had gotten.
      const ok = await writeLocationEnrichmentCache({
        [key]: {
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
        },
      })
      if (ok) {
        summary.written++
      } else if (summary.errors.length < 100) {
        summary.errors.push(`Anreicherungsdaten für ${auction.platform}/${auction.externalId} konnten nicht gespeichert werden.`)
      }
    } finally {
      void recordTaskRunProgress('external-enrichment', progressSnapshot(summary, total))
    }
  }

  await recordTaskRunProgress('external-enrichment', progressSnapshot(summary, total), { flush: true })
  summary.durationMs = Date.now() - startedAt
  return summary
}

function progressSnapshot(summary: ExternalEnrichmentSummary, total: number): TaskRunSummary {
  return {
    total,
    processed: summary.processed,
    skippedMissingCoordinates: summary.skippedMissingCoordinates,
    providerFailures: summary.providerFailures,
  }
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
  previous: LocationContext | null,
): Promise<LocationContext | null> {
  for (const adapter of adapters) {
    if (!adapter.supports(auction)) continue
    try {
      const result = await adapter.context(auction, previous)
      if (result) return result
    } catch (err) {
      recordProviderFailure(summary, adapter.id, 'location context', auction, err)
    }
  }
  return null
}

function sourceVersion(adapters: Array<{ id: string; sourceVersion: string }>): string {
  return adapters.length > 0
    ? adapters.map((adapter) => `${adapter.id}@${adapter.sourceVersion}`).join(',')
    : 'no-adapters'
}
