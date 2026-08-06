// Climate normals context for one auction's coordinates, cached per 0.1°
// ERA5-Land grid cell (climate_cells, server/db/schema/geo.ts) — WP-7's data
// model (docs/plans/2026-08-04-gis-wp7-klima-grid.md), populated lazily here
// for the detail-page climate chart. The search-filter half of WP-7
// (auction_geo_metrics.climateCellId, SearchFilters.vue) is out of scope for
// this adapter.
//
// Modelled as a LocationContextEnhancer, same as cams-air-quality.ts: a
// continuous property of the surrounding area, not a discrete object.
//
// Unlike air quality, one fetch here pulls 30 years of daily data — far too
// expensive to repeat on every external-enrichment run for every auction.
// Climate normals don't go stale (WP-7 doc: "einmal geholt, nie wieder"), so
// a cell is fetched at most once, ever, keyed by its rounded coordinates.

import type { Pool, PoolClient } from 'pg'
import type {
  Auction,
  LocationClimateMonthNormal,
  LocationClimateNormals,
  LocationContext,
} from '~/types/auction'
import type { LocationContextEnhancer } from '~/server/tasks/external-enrichment'
import { EXTERNAL_DATA_SOURCES } from './sources'

export interface OpenMeteoClimateOptions {
  db: Pool
  checkedAt: string
  serviceUrl?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

interface ArchiveDailyResponse {
  daily?: {
    time?: string[]
    temperature_2m_max?: (number | null)[]
    temperature_2m_min?: (number | null)[]
    temperature_2m_mean?: (number | null)[]
    precipitation_sum?: (number | null)[]
  } | null
}

export interface ClimateCellData {
  summerAvgTempC: number | null
  winterAvgTempC: number | null
  annualPrecipMm: number | null
  frostDays: number | null
  monthly: LocationClimateMonthNormal[]
}

const SOURCE = EXTERNAL_DATA_SOURCES.find((source) => source.id === 'open-meteo-climate-normals')!
const DEFAULT_SERVICE_URL = 'https://archive-api.open-meteo.com/v1/archive'
const DEFAULT_TIMEOUT_MS = 30_000
// WP-7 pitfall: "Referenzperiode nicht dokumentiert -> Werte sind später
// nicht reproduzierbar" — the period is baked into the version string, so a
// later change of period or source shows up as a version mismatch instead of
// silently mixing normals from two periods in the same table.
const NORMAL_PERIOD_START_YEAR = 1991
const NORMAL_PERIOD_END_YEAR = 2020
export const OPEN_METEO_CLIMATE_SOURCE_VERSION =
  `open-meteo-era5-land-${NORMAL_PERIOD_START_YEAR}-${NORMAL_PERIOD_END_YEAR}-v1`
const DAILY_FIELDS = ['temperature_2m_max', 'temperature_2m_min', 'temperature_2m_mean', 'precipitation_sum'] as const

export function createOpenMeteoClimateNormalsEnhancer(options: OpenMeteoClimateOptions): LocationContextEnhancer {
  return {
    id: 'open-meteo-climate-normals',
    sourceVersion: OPEN_METEO_CLIMATE_SOURCE_VERSION,
    supports: (auction: Auction) => Number.isFinite(auction.lat) && Number.isFinite(auction.lng),
    async enhance(auction, context) {
      const normals = await readClimateNormals({ lat: auction.lat!, lng: auction.lng! }, options)
      return normals ? applyClimateNormals(context, normals) : context
    },
  }
}

export async function readClimateNormals(
  point: { lat: number; lng: number },
  options: OpenMeteoClimateOptions,
): Promise<LocationClimateNormals | null> {
  const cell = gridCell(point.lat, point.lng)
  const cached = await readCachedCell(options.db, cell)
  if (cached) return toLocationClimateNormals(cached, options.checkedAt)

  // Cold cell: two concurrent requests can both observe the miss above
  // before either has written the row. A per-cell advisory lock (held for
  // the transaction, scoped to the checked-out client) serializes them, and
  // the re-read after acquiring it lets the loser of the race serve the
  // winner's freshly-cached row instead of hitting Open-Meteo again.
  return withCellLock(options.db, cell, async (client) => {
    const recached = await readCachedCell(client, cell)
    if (recached) return toLocationClimateNormals(recached, options.checkedAt)

    const daily = await fetchDailySeries(cell, options)
    if (!daily) return null
    const data = aggregate(daily)
    await writeCachedCell(client, cell, data)
    return toLocationClimateNormals(data, options.checkedAt)
  })
}

async function withCellLock<T>(
  db: Pool,
  cell: { lat: number; lon: number },
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [cellLockKey(cell)])
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

function cellLockKey(cell: { lat: number; lon: number }): string {
  return `climate-cell:${cell.lat.toFixed(1)}:${cell.lon.toFixed(1)}`
}

/** Floors to the nearest 0.1° — matches WP-7's cell-assignment rule exactly
 *  (docs/plans/2026-08-04-gis-wp7-klima-grid.md: "Abrunden der Koordinaten
 *  auf 0,1° ist ausreichend und deterministisch"), so a future batch job
 *  assigning auctions to cells (WP-5/WP-7) lands on the same cell this
 *  adapter already populated. Exported so that job can reuse it verbatim
 *  instead of re-deriving the rounding rule. */
export function gridCell(lat: number, lng: number): { lat: number; lon: number } {
  return {
    lat: Math.floor(lat * 10) / 10,
    lon: Math.floor(lng * 10) / 10,
  }
}

async function readCachedCell(db: Pool | PoolClient, cell: { lat: number; lon: number }): Promise<ClimateCellData | null> {
  const { rows } = await db.query<{
    summer_avg_temp_c: string | null
    winter_avg_temp_c: string | null
    annual_precip_mm: number | null
    frost_days: number | null
    monthly: LocationClimateMonthNormal[] | null
    source_version: string | null
    fetched_at: string | Date | null
  }>(
    `SELECT summer_avg_temp_c, winter_avg_temp_c, annual_precip_mm, frost_days, monthly, source_version, fetched_at
     FROM climate_cells WHERE lat = $1 AND lon = $2`,
    [cell.lat, cell.lon],
  )
  const row = rows[0]
  // fetched_at/monthly null means the row doesn't exist yet, or exists but
  // was never fully populated; a source_version mismatch means it was
  // populated by a normal period/adapter this one no longer trusts. Either
  // way, fetch fresh rather than serve a stale or partial cell.
  if (!row || row.fetched_at == null || row.monthly == null || row.source_version !== OPEN_METEO_CLIMATE_SOURCE_VERSION) {
    return null
  }
  return {
    summerAvgTempC: parseNullableNumeric(row.summer_avg_temp_c),
    winterAvgTempC: parseNullableNumeric(row.winter_avg_temp_c),
    annualPrecipMm: row.annual_precip_mm,
    frostDays: row.frost_days,
    monthly: row.monthly,
  }
}

async function writeCachedCell(
  db: Pool | PoolClient,
  cell: { lat: number; lon: number },
  data: ClimateCellData,
): Promise<void> {
  await db.query(
    `INSERT INTO climate_cells (lat, lon, summer_avg_temp_c, winter_avg_temp_c, annual_precip_mm, frost_days, monthly, source_version, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (lat, lon) DO UPDATE
       SET summer_avg_temp_c = EXCLUDED.summer_avg_temp_c,
           winter_avg_temp_c = EXCLUDED.winter_avg_temp_c,
           annual_precip_mm = EXCLUDED.annual_precip_mm,
           frost_days = EXCLUDED.frost_days,
           monthly = EXCLUDED.monthly,
           source_version = EXCLUDED.source_version,
           fetched_at = now()`,
    [
      cell.lat,
      cell.lon,
      data.summerAvgTempC,
      data.winterAvgTempC,
      data.annualPrecipMm,
      data.frostDays,
      JSON.stringify(data.monthly),
      OPEN_METEO_CLIMATE_SOURCE_VERSION,
    ],
  )
}

interface DailyPoint {
  year: number
  month: number
  tempMax: number | null
  tempMin: number | null
  tempMean: number | null
  precip: number | null
}

async function fetchDailySeries(
  cell: { lat: number; lon: number },
  options: OpenMeteoClimateOptions,
): Promise<DailyPoint[] | null> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const url = new URL(options.serviceUrl ?? DEFAULT_SERVICE_URL)
  url.searchParams.set('latitude', cell.lat.toFixed(2))
  url.searchParams.set('longitude', cell.lon.toFixed(2))
  url.searchParams.set('start_date', `${NORMAL_PERIOD_START_YEAR}-01-01`)
  url.searchParams.set('end_date', `${NORMAL_PERIOD_END_YEAR}-12-31`)
  url.searchParams.set('daily', DAILY_FIELDS.join(','))
  url.searchParams.set('timezone', 'UTC')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let payload: ArchiveDailyResponse
  try {
    const res = await fetchImpl(url.toString(), { signal: controller.signal })
    if (!res.ok) throw new Error(`open-meteo archive service returned ${res.status}`)
    payload = await res.json() as ArchiveDailyResponse
  } finally {
    clearTimeout(timer)
  }

  const daily = payload.daily
  if (!daily?.time?.length) return null
  // A response with a missing or short metric vector would otherwise turn
  // into all-null values for that metric (see validateDailyMetrics below),
  // which silently aggregates to NaN/null and then gets cached as if it were
  // a valid normal for this cell's source version — reject the whole
  // response instead so the cell stays uncached and gets retried later.
  const metrics = validateDailyMetrics(daily, daily.time.length)
  if (!metrics) return null
  return daily.time.map((date, i) => ({
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(5, 7)),
    tempMax: metrics.tempMax[i]!,
    tempMin: metrics.tempMin[i]!,
    tempMean: metrics.tempMean[i]!,
    precip: metrics.precip[i]!,
  }))
}

function validateDailyMetrics(
  daily: NonNullable<ArchiveDailyResponse['daily']>,
  length: number,
): { tempMax: number[]; tempMin: number[]; tempMean: number[]; precip: number[] } | null {
  const tempMax = daily.temperature_2m_max
  const tempMin = daily.temperature_2m_min
  const tempMean = daily.temperature_2m_mean
  const precip = daily.precipitation_sum
  if (
    !isCompleteSeries(tempMax, length)
    || !isCompleteSeries(tempMin, length)
    || !isCompleteSeries(tempMean, length)
    || !isCompleteSeries(precip, length)
  ) {
    return null
  }
  return { tempMax, tempMin, tempMean, precip }
}

function isCompleteSeries(field: (number | null)[] | undefined, length: number): field is number[] {
  return Array.isArray(field) && field.length === length && field.every((v) => typeof v === 'number' && Number.isFinite(v))
}

const SUMMER_MONTHS = [6, 7, 8]
const WINTER_MONTHS = [12, 1, 2]

export function aggregate(daily: DailyPoint[]): ClimateCellData {
  const years = [...new Set(daily.map((d) => d.year))]

  const summerMaxes = daily.filter((d) => SUMMER_MONTHS.includes(d.month) && d.tempMax != null).map((d) => d.tempMax!)
  const winterMeans = daily.filter((d) => WINTER_MONTHS.includes(d.month) && d.tempMean != null).map((d) => d.tempMean!)
  const frostDayCount = daily.filter((d) => d.tempMin != null && d.tempMin < 0).length

  const precipByYear = new Map<number, number>()
  const precipByYearMonth = new Map<string, number>()
  for (const d of daily) {
    if (d.precip == null) continue
    precipByYear.set(d.year, (precipByYear.get(d.year) ?? 0) + d.precip)
    const key = `${d.year}-${d.month}`
    precipByYearMonth.set(key, (precipByYearMonth.get(key) ?? 0) + d.precip)
  }

  const monthly: LocationClimateMonthNormal[] = []
  for (let month = 1; month <= 12; month++) {
    const maxes = daily.filter((d) => d.month === month && d.tempMax != null).map((d) => d.tempMax!)
    const means = daily.filter((d) => d.month === month && d.tempMean != null).map((d) => d.tempMean!)
    const mins = daily.filter((d) => d.month === month && d.tempMin != null).map((d) => d.tempMin!)
    const yearlyTotals = years.map((year) => precipByYearMonth.get(`${year}-${month}`) ?? 0)
    monthly.push({
      month,
      tempMaxAvgC: round(mean(maxes), 1),
      tempMeanAvgC: round(mean(means), 1),
      tempMinAvgC: round(mean(mins), 1),
      precipitationAvgMm: round(mean(yearlyTotals), 0),
    })
  }

  return {
    summerAvgTempC: summerMaxes.length ? round(mean(summerMaxes), 1) : null,
    winterAvgTempC: winterMeans.length ? round(mean(winterMeans), 1) : null,
    annualPrecipMm: precipByYear.size ? round(mean([...precipByYear.values()]), 0) : null,
    frostDays: years.length ? round(frostDayCount / years.length, 0) : null,
    monthly,
  }
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function parseNullableNumeric(value: string | null): number | null {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function toLocationClimateNormals(data: ClimateCellData, checkedAt: string): LocationClimateNormals {
  return {
    periodStartYear: NORMAL_PERIOD_START_YEAR,
    periodEndYear: NORMAL_PERIOD_END_YEAR,
    months: data.monthly,
    sourceLabel: SOURCE.label,
    sourceUrl: SOURCE.sourceUrl,
    checkedAt,
  }
}

export function applyClimateNormals(
  context: LocationContext,
  normals: LocationClimateNormals,
): LocationContext {
  const environment = { ...context.environment, climateNormals: normals }
  return {
    ...context,
    environment,
    source: {
      ...context.source,
      label: `${context.source.label} + ${SOURCE.label}`,
      licenseNote: `${context.source.licenseNote} ${SOURCE.licenseNote}`,
    },
  }
}
