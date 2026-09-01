// Default adapter/enhancer wiring for external-enrichment.ts, split out to
// keep that file under the 500-line production module gate (see CLAUDE.md).
import type { Pool } from 'pg'
import type { Auction } from '~/types/auction'
import { createDvfFileMarketAdapter } from '~/server/utils/external-data/fr-dvf-cache'
import { createEuFloodRiskFileAdapter } from '~/server/utils/external-data/eu-flood-risk'
import { createCopernicusEffisBurntAreaFileAdapter } from '~/server/utils/external-data/copernicus-effis'
import { createEeaEnvironmentalNoiseEnhancer } from '~/server/utils/external-data/eea-environmental-noise'
import { createCamsAirQualityEnhancer } from '~/server/utils/external-data/cams-air-quality'
import { createOpenMeteoClimateNormalsEnhancer } from '~/server/utils/external-data/open-meteo-climate'
import { createLocalOsmLocationContextAdapter } from '~/server/utils/external-data/osm-location-context'
import { mergeLocationContextWithPrevious } from '~/server/utils/external-data/location-context-merge'
import {
  getStoredExternalDataSourceConfig,
  getConfigurableExternalDataSource,
  resolveExternalDataSourceConfig,
  type ExternalDataSourceConfigValues,
} from '~/server/utils/external-data/config'
import type {
  ExternalEnrichmentSummary,
  HazardAssessmentAdapter,
  LocationContextAdapter,
  LocationContextEnhancer,
  MarketComparisonAdapter,
} from './external-enrichment'

export function recordProviderFailure(
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

export async function defaultMarketAdapters(db: Pool | null): Promise<MarketComparisonAdapter[]> {
  const adapters: MarketComparisonAdapter[] = []
  const values = await resolvedSourceValues(db, 'fr-dvf-geolocated')
  if (values) {
    adapters.push(await createDvfFileMarketAdapter({ cachePath: String(values.cachePath) }))
  }
  return adapters
}

export async function defaultHazardAdapters(
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
  const effisValues = await resolvedSourceValues(db, 'copernicus-effis')
  if (effisValues) {
    // Same rationale as the flood cache above: the burnt-area cache is filled
    // out-of-band (import-copernicus-effis-cache.ts) and a path just set from
    // /settings can legitimately not exist yet.
    try {
      adapters.push(await createCopernicusEffisBurntAreaFileAdapter({
        cachePath: String(effisValues.cachePath),
        checkedAt,
        maxCacheAgeDays: Number(effisValues.maxCacheAgeDays),
      }))
    } catch (err) {
      console.warn(
        `[external-enrichment] copernicus-effis cache unusable at ${String(effisValues.cachePath)}: ${(err as Error).message}`,
      )
    }
  }
  return adapters
}

export async function defaultLocationContextAdapters(
  db: Pool | null,
  checkedAt: string,
  summary: ExternalEnrichmentSummary,
): Promise<LocationContextAdapter[]> {
  // No config to resolve any more (osm_local_elements is loaded out-of-band by
  // a standalone osm2pgsql job, not fetched live) — just needs a DB to query.
  if (!db) return []
  const osmAdapter = createLocalOsmLocationContextAdapter({ db, checkedAt })
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
  const climateValues = await resolvedSourceValues(db, 'open-meteo-climate-normals')
  if (climateValues) {
    enhancers.push(createOpenMeteoClimateNormalsEnhancer({
      db,
      checkedAt,
      serviceUrl: String(climateValues.serviceUrl),
      timeoutMs: Number(climateValues.timeoutMs),
    }))
  }
  return [withLocationContextEnhancers(osmAdapter, enhancers, summary)]
}

export function withLocationContextEnhancers(
  adapter: LocationContextAdapter,
  enhancers: LocationContextEnhancer[],
  summary: ExternalEnrichmentSummary,
): LocationContextAdapter {
  if (enhancers.length === 0) return adapter
  return {
    id: [adapter.id, ...enhancers.map((enhancer) => enhancer.id)].join('+'),
    sourceVersion: [adapter.sourceVersion, ...enhancers.map((enhancer) => enhancer.sourceVersion)].join(','),
    supports: (auction) => adapter.supports(auction),
    async context(auction, previous) {
      let context = await adapter.context(auction, previous)
      if (!context) return null
      for (const enhancer of enhancers) {
        if (!enhancer.supports(auction, context)) continue
        try {
          context = await enhancer.enhance(auction, context)
        } catch (err) {
          // One enhancer failing (e.g. a rate-limited upstream) must not
          // discard what the earlier enhancers in this same chain already
          // added — otherwise a single 429 from the last enhancer reverts
          // the whole location context to last run's cached version.
          recordProviderFailure(summary, enhancer.id, 'location context enhancer', auction, err)
        }
      }
      return previous ? mergeLocationContextWithPrevious(context, previous) : context
    },
  }
}
