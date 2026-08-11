// Aggregate read for the admin technical overview of one auction identity
// (docs/plans/2026-08-08-admin-auktions-technikseite.md, WP-2). Pulls
// together crawl/fetch state, the raw document archive, the full extraction
// version history, LLM batch jobs, logged errors, external-data coverage and
// translation status — everything needed to answer "how did this auction's
// pipeline run" without re-deriving any of it. Every section reads from a
// table that already exists; nothing here is written anywhere else.

import type { Pool } from 'pg'
import { getPool } from './db'
import { readAuctionFetchState, type AuctionFetchState } from './auction-fetch-state'
import { readArchiveDocuments, type ArchiveDocumentRow } from './archive-documents'
import { listTaskRunErrorsForIdentity, type TaskRunError } from './task-run-errors'
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

export interface AuctionDetailsVersionRow {
  version: number
  createdAt: string
  extractedAt: string
  isLatest: boolean
  isTrial: boolean
  artifactVersionId: number | null
  extractionSource: string | null
  extractionConfidence: string | null
  llmAnalyzedAt: string | null
  llmProvider: string | null
  llmModel: string | null
  llmProfileId: string | null
  runTrigger: string | null
  llmDurationMs: number | null
  llmCostUsd: number | null
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

/** Individual provider invocations, unlike extractionHistory which contains
 * only versions that made it into auction_details. */
export interface AuctionLlmCallRow {
  id: number
  occurredAt: string
  provider: string
  model: string
  executionMode: string
  status: 'succeeded' | 'failed'
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
  durationMs: number | null
  errorMessage: string | null
}

export interface AuctionTechnicalOverview {
  identity: AuctionIdentity
  fetchState: AuctionFetchState | null
  documents: ArchiveDocumentRow[]
  extractionHistory: AuctionDetailsVersionRow[]
  llmCalls: AuctionLlmCallRow[]
  llmBatchJobs: LlmBatchJob[]
  errors: TaskRunError[]
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
  extracted_at: Date | string
  is_latest: boolean
  is_trial: boolean
  artifact_version_id: string | number | null
  extraction_source: string | null
  extraction_confidence: string | null
  llm_analyzed_at: Date | string | null
  llm_provider: string | null
  llm_model: string | null
  llm_profile_id: string | null
  run_trigger: string | null
  llm_duration_ms: number | null
  llm_cost_usd: number | null
}

async function readExtractionHistory(db: Pool, platform: string, externalId: string): Promise<AuctionDetailsVersionRow[]> {
  const { rows } = await db.query<DetailsVersionQueryRow>(
    `SELECT version, created_at, extracted_at, is_latest, is_trial, artifact_version_id,
            extraction_source, extraction_confidence, llm_analyzed_at,
            llm_provider, llm_model, llm_profile_id, run_trigger, llm_duration_ms, llm_cost_usd
     FROM auction_details WHERE platform = $1 AND external_id = $2 ORDER BY version DESC`,
    [platform, externalId],
  )
  return rows.map((row) => ({
    version: row.version,
    createdAt: iso(row.created_at),
    extractedAt: iso(row.extracted_at),
    isLatest: row.is_latest,
    isTrial: row.is_trial,
    artifactVersionId: row.artifact_version_id == null ? null : Number(row.artifact_version_id),
    extractionSource: row.extraction_source,
    extractionConfidence: row.extraction_confidence,
    llmAnalyzedAt: iso(row.llm_analyzed_at),
    llmProvider: row.llm_provider,
    llmModel: row.llm_model,
    llmProfileId: row.llm_profile_id,
    runTrigger: row.run_trigger,
    llmDurationMs: row.llm_duration_ms,
    llmCostUsd: row.llm_cost_usd,
  }))
}

interface LlmCallQueryRow {
  id: string | number
  occurred_at: Date | string
  provider: string
  model: string
  execution_mode: string
  status: string
  input_tokens: number | null
  output_tokens: number | null
  cost_usd: number | null
  duration_ms: number | null
  error_message: string | null
}

async function readLlmCalls(db: Pool, platform: string, externalId: string): Promise<AuctionLlmCallRow[]> {
  const { rows } = await db.query<LlmCallQueryRow>(
    `SELECT id, occurred_at, provider, model, execution_mode, status,
            input_tokens, output_tokens, cost_usd, duration_ms, error_message
     FROM llm_usage_events
     WHERE platform = $1 AND external_id = $2
     ORDER BY occurred_at DESC, id DESC
     LIMIT 100`,
    [platform, externalId],
  )
  return rows.map((row) => ({
    id: Number(row.id),
    occurredAt: iso(row.occurred_at)!,
    provider: row.provider,
    model: row.model,
    executionMode: row.execution_mode,
    status: row.status === 'failed' ? 'failed' : 'succeeded',
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    durationMs: row.duration_ms,
    errorMessage: row.error_message,
  }))
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
  const [fetchState, documents, extractionHistory, llmCalls, errors, recentBatchJobs, coverage, geo, translations] = await Promise.all([
    readAuctionFetchState(platform, externalId),
    readArchiveDocuments(db, platform, externalId),
    readExtractionHistory(db, platform, externalId),
    readLlmCalls(db, platform, externalId),
    listTaskRunErrorsForIdentity(platform, externalId, 100),
    listRecentLlmBatchJobs(50),
    computeAuctionExternalDataCoverage(db, platform, externalId),
    readGeoMetrics(db, platform, externalId),
    readTranslations(db, platform, externalId),
  ])

  return {
    identity,
    fetchState,
    documents,
    extractionHistory,
    llmCalls,
    llmBatchJobs: recentBatchJobs.filter((job) => Object.values(job.customIdMap).includes(identityKey)),
    errors,
    externalData: { coverage, geoMetrics: geo.geoMetrics, climateCell: geo.climateCell },
    translations,
  }
}
