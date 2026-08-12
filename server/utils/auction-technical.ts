// Aggregate read for the admin technical overview of one auction identity
// (docs/plans/2026-08-08-admin-auktions-technikseite.md, WP-2). Pulls
// together crawl/fetch state, the raw document archive, the full extraction
// run history (successful versions merged with failed provider attempts),
// LLM batch jobs, external-data coverage and translation status — everything
// needed to answer "how did this auction's pipeline run" without re-deriving
// any of it. Every section reads from a table that already exists; nothing
// here is written anywhere else.

import type { Pool } from 'pg'
import { getPool } from './db'
import { readAuctionFetchState, type AuctionFetchState } from './auction-fetch-state'
import { readArchiveDocuments, type ArchiveDocumentRow } from './archive-documents'
import { listRecentLlmBatchJobs, type LlmBatchJob } from './llm-batch-jobs'
import { computeAuctionExternalDataCoverage, type AuctionExternalDataCoverage } from './external-data/auction-coverage'

export interface AuctionIdentity {
  platform: string
  externalId: string
  country: string
  region: string
  authority: string
  caseNumber: string
  title: string | null
  lat: number | null
  lng: number | null
  geocodeAttemptedAt: string | null
  geocodeResult: string | null
  geocodeProvider: string | null
  firstSeenAt: string
  updatedAt: string
}

/** One row per extraction attempt for this identity — either a persisted
 *  auction_details version (status 'success', from readExtractionHistory) or
 *  a provider call that never became one (status 'failed', from
 *  readFailedExtractionAttempts), merged and time-ordered by
 *  mergeExtractionRuns. Only a 'success' row has a real `version` — that's
 *  what the admin page's select/promote/diff actions operate on; a 'failed'
 *  row is informational only. */
export interface AuctionExtractionRunRow {
  /** Stable key for the frontend to render/key on — a real version's own
   *  version number, or the backing llm_usage_events id for a failed
   *  attempt. The two id spaces never collide (see the `f`/`v` prefixes). */
  id: string
  version: number | null
  createdAt: string
  status: 'success' | 'failed'
  isLatest: boolean
  isTrial: boolean
  artifactVersionId: number | null
  extractionSource: string | null
  extractionConfidence: string | null
  llmProvider: string | null
  llmModel: string | null
  llmProfileId: string | null
  runTrigger: string | null
  llmDurationMs: number | null
  llmCostUsd: number | null
  llmInputTokens: number | null
  llmOutputTokens: number | null
  errorMessage: string | null
}

export interface AuctionGeoMetricsRow {
  distSeaM: number | null
  distLakeM: number | null
  distRiverM: number | null
  distMountainM: number | null
  distAirportM: number | null
  distSkiM: number | null
  tourismDensityCount: number | null
  featuresEpoch: number
  pointHash: string | null
  computedAt: string | null
}

export interface ClimateCellRow {
  summerAvgTempC: number | null
  winterAvgTempC: number | null
  annualPrecipMm: number | null
  frostDays: number | null
  sourceVersion: string | null
  fetchedAt: string | null
}

export interface AuctionTranslationStatusRow {
  lang: string
  version: number
  status: string
  errorMessage: string | null
  failedConfig: string | null
  startedAt: string
  completedAt: string | null
}

export interface AuctionTechnicalOverview {
  identity: AuctionIdentity
  fetchState: AuctionFetchState | null
  documents: ArchiveDocumentRow[]
  extractionHistory: AuctionExtractionRunRow[]
  llmBatchJobs: LlmBatchJob[]
  externalData: {
    coverage: AuctionExternalDataCoverage | null
    geoMetrics: AuctionGeoMetricsRow | null
    climateCell: ClimateCellRow | null
  }
  translations: AuctionTranslationStatusRow[]
}

interface IdentityRow {
  platform: string
  external_id: string
  country: string
  region: string
  authority: string
  case_number: string
  title: string | null
  lat: string | null
  lng: string | null
  geocode_attempted_at: Date | string | null
  geocode_result: string | null
  geocode_provider: string | null
  first_seen_at: Date | string
  updated_at: Date | string
}

function iso(value: Date | string): string
function iso(value: Date | string | null): string | null
function iso(value: Date | string | null): string | null {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : value
}

async function readIdentity(db: Pool, platform: string, externalId: string): Promise<AuctionIdentity | null> {
  const { rows } = await db.query<IdentityRow>(
    `SELECT platform, external_id, country, region, authority, case_number, title, lat, lng,
            geocode_attempted_at, geocode_result, geocode_provider, first_seen_at, updated_at
     FROM auctions WHERE platform = $1 AND external_id = $2`,
    [platform, externalId],
  )
  const row = rows[0]
  if (!row) return null
  return {
    platform: row.platform,
    externalId: row.external_id,
    country: row.country,
    region: row.region,
    authority: row.authority,
    caseNumber: row.case_number,
    title: row.title,
    lat: row.lat == null ? null : Number(row.lat),
    lng: row.lng == null ? null : Number(row.lng),
    geocodeAttemptedAt: iso(row.geocode_attempted_at),
    geocodeResult: row.geocode_result,
    geocodeProvider: row.geocode_provider,
    firstSeenAt: iso(row.first_seen_at),
    updatedAt: iso(row.updated_at),
  }
}

interface DetailsVersionQueryRow {
  version: number
  created_at: Date | string
  is_latest: boolean
  is_trial: boolean
  artifact_version_id: string | number | null
  extraction_source: string | null
  extraction_confidence: string | null
  llm_provider: string | null
  llm_model: string | null
  llm_profile_id: string | null
  run_trigger: string | null
  llm_duration_ms: number | null
  llm_cost_usd: number | null
  llm_input_tokens: number | null
  llm_output_tokens: number | null
}

async function readExtractionHistory(db: Pool, platform: string, externalId: string): Promise<AuctionExtractionRunRow[]> {
  const { rows } = await db.query<DetailsVersionQueryRow>(
    `SELECT version, created_at, is_latest, is_trial, artifact_version_id,
            extraction_source, extraction_confidence,
            llm_provider, llm_model, llm_profile_id, run_trigger, llm_duration_ms, llm_cost_usd,
            llm_input_tokens, llm_output_tokens
     FROM auction_details WHERE platform = $1 AND external_id = $2 ORDER BY version DESC`,
    [platform, externalId],
  )
  return rows.map((row) => ({
    id: `v${row.version}`,
    version: row.version,
    createdAt: iso(row.created_at),
    status: 'success' as const,
    isLatest: row.is_latest,
    isTrial: row.is_trial,
    artifactVersionId: row.artifact_version_id == null ? null : Number(row.artifact_version_id),
    extractionSource: row.extraction_source,
    extractionConfidence: row.extraction_confidence,
    llmProvider: row.llm_provider,
    llmModel: row.llm_model,
    llmProfileId: row.llm_profile_id,
    runTrigger: row.run_trigger,
    llmDurationMs: row.llm_duration_ms,
    llmCostUsd: row.llm_cost_usd,
    llmInputTokens: row.llm_input_tokens,
    llmOutputTokens: row.llm_output_tokens,
    errorMessage: null,
  }))
}

interface FailedAttemptQueryRow {
  id: string | number
  occurred_at: Date | string
  provider: string
  model: string
  profile_id: string | null
  source: string | null
  duration_ms: number | null
  input_tokens: number | null
  output_tokens: number | null
  error_message: string | null
}

/** Provider calls that never became an auction_details version — the
 *  extraction-run counterpart to a "Live"/"Trial" row above. task='extraction'
 *  keeps translation/place-name-translation calls (which have their own
 *  section) out of this table. */
async function readFailedExtractionAttempts(db: Pool, platform: string, externalId: string): Promise<AuctionExtractionRunRow[]> {
  const { rows } = await db.query<FailedAttemptQueryRow>(
    `SELECT id, occurred_at, provider, model, profile_id, source,
            duration_ms, input_tokens, output_tokens, error_message
     FROM llm_usage_events
     WHERE platform = $1 AND external_id = $2 AND task = 'extraction' AND status = 'failed'
     ORDER BY occurred_at DESC, id DESC
     LIMIT 100`,
    [platform, externalId],
  )
  return rows.map((row) => ({
    id: `f${row.id}`,
    version: null,
    createdAt: iso(row.occurred_at)!,
    status: 'failed' as const,
    isLatest: false,
    isTrial: row.source === 'admin-trial',
    artifactVersionId: null,
    extractionSource: null,
    extractionConfidence: null,
    llmProvider: row.provider,
    llmModel: row.model,
    llmProfileId: row.profile_id,
    // llm_usage_events has no run_trigger; only 'admin-trial' maps onto one
    // ('manual', the same value the trial version is written with). Anything
    // else keeps its own source rather than claiming a trigger it never had —
    // a reprocess call is just as likely manual as scheduled.
    runTrigger: row.source === 'admin-trial' ? 'manual' : row.source,
    llmDurationMs: row.duration_ms,
    llmCostUsd: null,
    llmInputTokens: row.input_tokens,
    llmOutputTokens: row.output_tokens,
    errorMessage: row.error_message,
  }))
}

function mergeExtractionRuns(versions: AuctionExtractionRunRow[], failedAttempts: AuctionExtractionRunRow[]): AuctionExtractionRunRow[] {
  return [...versions, ...failedAttempts].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

interface GeoMetricsQueryRow {
  dist_sea_m: number | null
  dist_lake_m: number | null
  dist_river_m: number | null
  dist_mountain_m: number | null
  dist_airport_m: number | null
  dist_ski_m: number | null
  tourism_density_count: number | null
  features_epoch: number
  point_hash: string | null
  computed_at: Date | string | null
  climate_summer_avg_temp_c: string | null
  climate_winter_avg_temp_c: string | null
  climate_annual_precip_mm: number | null
  climate_frost_days: number | null
  climate_source_version: string | null
  climate_fetched_at: Date | string | null
}

async function readGeoMetrics(
  db: Pool,
  platform: string,
  externalId: string,
): Promise<{ geoMetrics: AuctionGeoMetricsRow | null; climateCell: ClimateCellRow | null }> {
  const { rows } = await db.query<GeoMetricsQueryRow>(
    `SELECT gm.dist_sea_m, gm.dist_lake_m, gm.dist_river_m, gm.dist_mountain_m, gm.dist_airport_m, gm.dist_ski_m,
            gm.tourism_density_count, gm.features_epoch, gm.point_hash, gm.computed_at,
            cc.summer_avg_temp_c AS climate_summer_avg_temp_c, cc.winter_avg_temp_c AS climate_winter_avg_temp_c,
            cc.annual_precip_mm AS climate_annual_precip_mm, cc.frost_days AS climate_frost_days,
            cc.source_version AS climate_source_version, cc.fetched_at AS climate_fetched_at
     FROM auction_geo_metrics gm
     LEFT JOIN climate_cells cc ON cc.id = gm.climate_cell_id
     WHERE gm.platform = $1 AND gm.external_id = $2`,
    [platform, externalId],
  )
  const row = rows[0]
  if (!row) return { geoMetrics: null, climateCell: null }
  return {
    geoMetrics: {
      distSeaM: row.dist_sea_m,
      distLakeM: row.dist_lake_m,
      distRiverM: row.dist_river_m,
      distMountainM: row.dist_mountain_m,
      distAirportM: row.dist_airport_m,
      distSkiM: row.dist_ski_m,
      tourismDensityCount: row.tourism_density_count,
      featuresEpoch: row.features_epoch,
      pointHash: row.point_hash,
      computedAt: iso(row.computed_at),
    },
    climateCell: row.climate_fetched_at == null && row.climate_summer_avg_temp_c == null
      ? null
      : {
          summerAvgTempC: row.climate_summer_avg_temp_c == null ? null : Number(row.climate_summer_avg_temp_c),
          winterAvgTempC: row.climate_winter_avg_temp_c == null ? null : Number(row.climate_winter_avg_temp_c),
          annualPrecipMm: row.climate_annual_precip_mm,
          frostDays: row.climate_frost_days,
          sourceVersion: row.climate_source_version,
          fetchedAt: iso(row.climate_fetched_at),
        },
  }
}

interface TranslationQueryRow {
  lang: string
  version: number
  status: string
  error_message: string | null
  failed_config: string | null
  started_at: Date | string
  completed_at: Date | string | null
}

async function readTranslations(db: Pool, platform: string, externalId: string): Promise<AuctionTranslationStatusRow[]> {
  const { rows } = await db.query<TranslationQueryRow>(
    `SELECT lang, version, status, error_message, failed_config, started_at, completed_at
     FROM auction_translations WHERE platform = $1 AND external_id = $2
     ORDER BY version DESC, lang ASC`,
    [platform, externalId],
  )
  return rows.map((row) => ({
    lang: row.lang,
    version: row.version,
    status: row.status,
    errorMessage: row.error_message,
    failedConfig: row.failed_config,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
  }))
}

/** Returns null when the identity doesn't exist at all — every other section
 *  is an empty/default value for a real identity with no data yet, so only a
 *  missing `auctions` row is a 404. */
export async function readAuctionTechnicalOverview(platform: string, externalId: string): Promise<AuctionTechnicalOverview | null> {
  const db = getPool()
  if (!db) return null

  const identity = await readIdentity(db, platform, externalId)
  if (!identity) return null

  const identityKey = `${platform}:${externalId}`
  const [fetchState, documents, extractionVersions, failedAttempts, recentBatchJobs, coverage, geo, translations] = await Promise.all([
    readAuctionFetchState(platform, externalId),
    readArchiveDocuments(db, platform, externalId),
    readExtractionHistory(db, platform, externalId),
    readFailedExtractionAttempts(db, platform, externalId),
    listRecentLlmBatchJobs(50),
    computeAuctionExternalDataCoverage(db, platform, externalId),
    readGeoMetrics(db, platform, externalId),
    readTranslations(db, platform, externalId),
  ])

  return {
    identity,
    fetchState,
    documents,
    extractionHistory: mergeExtractionRuns(extractionVersions, failedAttempts),
    llmBatchJobs: recentBatchJobs.filter((job) => Object.values(job.customIdMap).includes(identityKey)),
    externalData: { coverage, geoMetrics: geo.geoMetrics, climateCell: geo.climateCell },
    translations,
  }
}
