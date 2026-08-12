import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPool } from './db'
import { readAuctionFetchState } from './auction-fetch-state'
import { readArchiveDocuments } from './archive-documents'
import { listRecentLlmBatchJobs } from './llm-batch-jobs'
import { computeAuctionExternalDataCoverage } from './external-data/auction-coverage'
import { readAuctionTechnicalOverview } from './auction-technical'

vi.mock('./db', () => ({ getPool: vi.fn() }))
vi.mock('./auction-fetch-state', () => ({ readAuctionFetchState: vi.fn() }))
vi.mock('./archive-documents', () => ({ readArchiveDocuments: vi.fn() }))
vi.mock('./llm-batch-jobs', () => ({ listRecentLlmBatchJobs: vi.fn() }))
vi.mock('./external-data/auction-coverage', () => ({ computeAuctionExternalDataCoverage: vi.fn() }))

const IDENTITY_ROW = {
  platform: 'zvg-portal',
  external_id: '7265',
  country: 'de',
  region: 'bayern',
  authority: 'AG München',
  case_number: '12 K 3/26',
  title: 'Einfamilienhaus',
  lat: '48.1',
  lng: '11.5',
  geocode_attempted_at: '2026-08-01T09:00:00.000Z',
  geocode_result: 'geocoded',
  geocode_provider: 'nominatim',
  first_seen_at: '2026-07-01T08:00:00.000Z',
  updated_at: '2026-08-02T10:00:00.000Z',
}

const DETAILS_ROW = {
  version: 3,
  created_at: '2026-08-02T10:00:00.000Z',
  is_latest: true,
  is_trial: false,
  artifact_version_id: '11',
  extraction_source: 'llm',
  extraction_confidence: 'high',
  llm_provider: 'openrouter',
  llm_model: 'deepseek/deepseek-v4-pro',
  llm_profile_id: 'profile-1',
  run_trigger: 'cron',
  llm_duration_ms: 4200,
  llm_cost_usd: 0.012,
  llm_input_tokens: 1200,
  llm_output_tokens: 400,
}

const GEO_ROW = {
  dist_sea_m: 12000,
  dist_lake_m: null,
  dist_river_m: 800,
  dist_mountain_m: null,
  dist_airport_m: 20000,
  dist_ski_m: null,
  tourism_density_count: 3,
  features_epoch: 5,
  point_hash: 'abc123',
  computed_at: '2026-08-01T00:00:00.000Z',
  climate_summer_avg_temp_c: '24.5',
  climate_winter_avg_temp_c: '2.1',
  climate_annual_precip_mm: 800,
  climate_frost_days: 60,
  climate_source_version: 'open-meteo-era5-land-1991-2020-v1',
  climate_fetched_at: '2026-07-15T00:00:00.000Z',
}

const TRANSLATION_ROW = {
  lang: 'en',
  version: 3,
  status: 'failed',
  error_message: 'openrouter: [POST] "https://openrouter.ai/api/v1/chat/completions": 404 Not Found',
  failed_config: 'fp-1',
  started_at: '2026-08-02T11:00:00.000Z',
  completed_at: null,
}

const FAILED_ATTEMPT_ROW = {
  id: '42',
  occurred_at: '2026-08-02T09:00:00.000Z',
  provider: 'openrouter',
  model: 'deepseek/deepseek-r2',
  profile_id: 'profile-2',
  source: 'admin-trial',
  duration_ms: 900,
  input_tokens: 1100,
  output_tokens: null,
  error_message: 'openrouter: [POST] "https://openrouter.ai/api/v1/chat/completions": 404 Not Found',
}

function mockQuery() {
  return vi.fn(async (sql: string) => {
    if (sql.includes('FROM auctions')) return { rows: [IDENTITY_ROW] }
    if (sql.includes('FROM auction_details')) return { rows: [DETAILS_ROW] }
    if (sql.includes('FROM llm_usage_events')) return { rows: [FAILED_ATTEMPT_ROW] }
    if (sql.includes('FROM auction_geo_metrics')) return { rows: [GEO_ROW] }
    if (sql.includes('FROM auction_translations')) return { rows: [TRANSLATION_ROW] }
    throw new Error(`unexpected query: ${sql}`)
  })
}

beforeEach(() => {
  vi.mocked(getPool).mockReturnValue({ query: mockQuery() } as never)
  vi.mocked(readAuctionFetchState).mockResolvedValue(null)
  vi.mocked(readArchiveDocuments).mockResolvedValue([])
  vi.mocked(listRecentLlmBatchJobs).mockResolvedValue([])
  vi.mocked(computeAuctionExternalDataCoverage).mockResolvedValue(null)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('readAuctionTechnicalOverview', () => {
  it('returns null when the identity does not exist', async () => {
    vi.mocked(getPool).mockReturnValue({ query: vi.fn(async () => ({ rows: [] })) } as never)

    await expect(readAuctionTechnicalOverview('zvg-portal', 'missing')).resolves.toBeNull()
  })

  it('aggregates identity, extraction runs, geo metrics and translations from the raw queries', async () => {
    const overview = await readAuctionTechnicalOverview('zvg-portal', '7265')

    expect(overview?.identity).toEqual({
      platform: 'zvg-portal',
      externalId: '7265',
      country: 'de',
      region: 'bayern',
      authority: 'AG München',
      caseNumber: '12 K 3/26',
      title: 'Einfamilienhaus',
      lat: 48.1,
      lng: 11.5,
      geocodeAttemptedAt: '2026-08-01T09:00:00.000Z',
      geocodeResult: 'geocoded',
      geocodeProvider: 'nominatim',
      firstSeenAt: '2026-07-01T08:00:00.000Z',
      updatedAt: '2026-08-02T10:00:00.000Z',
    })
    // Merged and time-ordered: the successful version (10:00) before the
    // failed attempt (09:00), even though they come from different tables.
    expect(overview?.extractionHistory).toEqual([
      {
        id: 'v3',
        version: 3,
        createdAt: '2026-08-02T10:00:00.000Z',
        status: 'success',
        isLatest: true,
        isTrial: false,
        artifactVersionId: 11,
        extractionSource: 'llm',
        extractionConfidence: 'high',
        llmProvider: 'openrouter',
        llmModel: 'deepseek/deepseek-v4-pro',
        llmProfileId: 'profile-1',
        runTrigger: 'cron',
        llmDurationMs: 4200,
        llmCostUsd: 0.012,
        llmInputTokens: 1200,
        llmOutputTokens: 400,
        errorMessage: null,
      },
      {
        id: 'f42',
        version: null,
        createdAt: '2026-08-02T09:00:00.000Z',
        status: 'failed',
        isLatest: false,
        isTrial: true,
        artifactVersionId: null,
        extractionSource: null,
        extractionConfidence: null,
        llmProvider: 'openrouter',
        llmModel: 'deepseek/deepseek-r2',
        llmProfileId: 'profile-2',
        runTrigger: 'manual',
        llmDurationMs: 900,
        llmCostUsd: null,
        llmInputTokens: 1100,
        llmOutputTokens: null,
        errorMessage: 'openrouter: [POST] "https://openrouter.ai/api/v1/chat/completions": 404 Not Found',
      },
    ])
    expect(overview?.externalData.geoMetrics).toEqual({
      distSeaM: 12000,
      distLakeM: null,
      distRiverM: 800,
      distMountainM: null,
      distAirportM: 20000,
      distSkiM: null,
      tourismDensityCount: 3,
      featuresEpoch: 5,
      pointHash: 'abc123',
      computedAt: '2026-08-01T00:00:00.000Z',
    })
    expect(overview?.externalData.climateCell).toEqual({
      summerAvgTempC: 24.5,
      winterAvgTempC: 2.1,
      annualPrecipMm: 800,
      frostDays: 60,
      sourceVersion: 'open-meteo-era5-land-1991-2020-v1',
      fetchedAt: '2026-07-15T00:00:00.000Z',
    })
    expect(overview?.translations).toEqual([{
      lang: 'en',
      version: 3,
      status: 'failed',
      errorMessage: 'openrouter: [POST] "https://openrouter.ai/api/v1/chat/completions": 404 Not Found',
      failedConfig: 'fp-1',
      startedAt: '2026-08-02T11:00:00.000Z',
      completedAt: null,
    }])
  })

  it('keeps only LLM batch jobs whose custom_id_map references this identity', async () => {
    vi.mocked(listRecentLlmBatchJobs).mockResolvedValue([
      {
        jobName: 'job-a', source: 'reprocess', status: 'pending', itemCount: 2,
        customIdMap: { c1: 'zvg-portal:7265', c2: 'zvg-portal:9999' },
        submittedAt: '2026-08-02T09:00:00.000Z', checkedAt: null, updatedAt: '2026-08-02T09:00:00.000Z', errorMessage: null,
        provider: null, model: null, profileId: null,
      },
      {
        jobName: 'job-b', source: 'reprocess', status: 'succeeded', itemCount: 1,
        customIdMap: { c1: 'zvg-portal:9999' },
        submittedAt: '2026-08-01T09:00:00.000Z', checkedAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-01T10:00:00.000Z', errorMessage: null,
        provider: null, model: null, profileId: null,
      },
    ])

    const overview = await readAuctionTechnicalOverview('zvg-portal', '7265')

    expect(overview?.llmBatchJobs.map((job) => job.jobName)).toEqual(['job-a'])
  })
})
