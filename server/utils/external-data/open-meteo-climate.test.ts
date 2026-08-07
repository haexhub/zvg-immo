import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import {
  aggregate,
  applyClimateNormals,
  createOpenMeteoClimateNormalsEnhancer,
  gridCell,
  OPEN_METEO_CLIMATE_SOURCE_VERSION,
  readClimateNormals,
} from './open-meteo-climate'
import { buildLocationContext } from './osm-location-context'
import type { Auction } from '~/types/auction'

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'test',
    country: 'se',
    region: 'Blekinge',
    externalId: '42',
    caseNumber: 'F-42',
    authority: 'Kronofogden',
    title: 'Hus',
    address: 'Skyttevagen 6',
    marketValueEur: 52_000,
    marketValueText: '575000 SEK',
    auctionDateIso: null,
    auctionDateText: null,
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl: null,
    pdfUrlUpstream: null,
    detailUrlUpstream: null,
    attachments: [],
    description: null,
    photoCount: 0,
    thumbnailUrl: null,
    lat: 48.137,
    lng: 11.575,
    ...overrides,
  }
}

function context() {
  return buildLocationContext({ lat: 48.137, lng: 11.575 }, [], '2026-08-06T00:00:00.000Z')
}

// Two years, one day per calendar month per year — just enough for every
// aggregate (monthly pool, summer/winter mean, frost days, annual precip) to
// have a deterministic, hand-computable answer, without 30 years of noise.
const SAMPLE_DAYS = [
  // month, year, tempMax, tempMin, tempMean, precip
  [1, 2011, 2, -8, -5, 30], [1, 2012, 4, -6, -3, 20],
  [2, 2011, 1, -9, -4, 18], [2, 2012, 2, -7, -2, 15],
  [3, 2011, 15, 2, 8, 10], [3, 2012, 15, 2, 8, 10],
  [4, 2011, 15, 2, 8, 10], [4, 2012, 15, 2, 8, 10],
  [5, 2011, 15, 2, 8, 10], [5, 2012, 15, 2, 8, 10],
  [6, 2011, 25, 10, 18, 5], [6, 2012, 27, 11, 19, 8],
  [7, 2011, 30, 14, 22, 2], [7, 2012, 32, 15, 23, 3],
  [8, 2011, 28, 12, 20, 4], [8, 2012, 29, 13, 21, 6],
  [9, 2011, 15, 2, 8, 10], [9, 2012, 15, 2, 8, 10],
  [10, 2011, 15, 2, 8, 10], [10, 2012, 15, 2, 8, 10],
  [11, 2011, 15, 2, 8, 10], [11, 2012, 15, 2, 8, 10],
  [12, 2011, 3, -6, -2, 25], [12, 2012, 4, -5, -1, 22],
] as const

function buildSampleDaily() {
  return SAMPLE_DAYS.map(([month, year, tempMax, tempMin, tempMean, precip]) => ({
    year, month, tempMax, tempMin, tempMean, precip,
  }))
}

function buildSampleArchiveResponse(): Response {
  const sorted = [...SAMPLE_DAYS].sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]))
  const daily = {
    time: sorted.map(([month, year]) => `${year}-${String(month).padStart(2, '0')}-15`),
    temperature_2m_max: sorted.map(([, , tempMax]) => tempMax),
    temperature_2m_min: sorted.map(([, , , tempMin]) => tempMin),
    temperature_2m_mean: sorted.map(([, , , , tempMean]) => tempMean),
    precipitation_sum: sorted.map(([, , , , , precip]) => precip),
  }
  return new Response(JSON.stringify({ daily }), { status: 200 })
}

describe('gridCell', () => {
  it('floors coordinates to the nearest 0.1°', () => {
    expect(gridCell(48.137, 11.575)).toEqual({ lat: 48.1, lon: 11.5 })
  })

  it('floors negative coordinates toward more-negative, not toward zero', () => {
    expect(gridCell(-0.05, -0.05)).toEqual({ lat: -0.1, lon: -0.1 })
  })
})

describe('aggregate', () => {
  const data = aggregate(buildSampleDaily())

  it('averages daily max/mean/min temperature by calendar month across years', () => {
    const january = data.monthly.find((m) => m.month === 1)!
    // maxes [2, 4] -> 3, means [-5, -3] -> -4, mins [-8, -6] -> -7
    expect(january).toMatchObject({ tempMaxAvgC: 3, tempMeanAvgC: -4, tempMinAvgC: -7 })
  })

  it('averages yearly monthly precipitation totals, not raw daily values', () => {
    const january = data.monthly.find((m) => m.month === 1)!
    // one day per month per year here, so the "yearly total" is just that day: [30, 20] -> 25
    expect(january.precipitationAvgMm).toBe(25)
  })

  it('returns twelve months, ordered', () => {
    expect(data.monthly.map((m) => m.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  it('averages daily-max temperature over June-August for summerAvgTempC', () => {
    // [25, 27, 30, 32, 28, 29] -> mean 28.5
    expect(data.summerAvgTempC).toBe(28.5)
  })

  it('averages daily-mean temperature over Dec-Feb for winterAvgTempC', () => {
    // [-2, -1, -5, -3, -4, -2] -> mean -17/6 = -2.8(3)
    expect(data.winterAvgTempC).toBe(-2.8)
  })

  it('averages the yearly count of sub-zero tempMin days for frostDays', () => {
    // 2011: Jan -8, Feb -9, Dec -6 = 3; 2012: Jan -6, Feb -7, Dec -5 = 3 -> mean 3
    expect(data.frostDays).toBe(3)
  })

  it('averages yearly precipitation totals for annualPrecipMm', () => {
    // 2011 total 144mm, 2012 total 134mm -> mean 139
    expect(data.annualPrecipMm).toBe(139)
  })
})

describe('createOpenMeteoClimateNormalsEnhancer / readClimateNormals', () => {
  // Models the same-cell serialization a real pg_advisory_xact_lock gives: a
  // second lock request for a key already held waits for the holder's
  // COMMIT/ROLLBACK before it proceeds. A successful write updates `row` so
  // the loser's re-read (inside the lock) sees the winner's cached result.
  function fakePool(existingRow: Record<string, unknown> | null = null) {
    const inserted: unknown[][] = []
    let row = existingRow
    const locks = new Map<string, Promise<void>>()

    async function acquireLock(key: string): Promise<() => void> {
      while (locks.has(key)) await locks.get(key)
      let release!: () => void
      locks.set(key, new Promise((resolve) => { release = resolve }))
      return () => { locks.delete(key); release() }
    }

    function makeQuery() {
      let releaseLock: (() => void) | null = null
      return vi.fn(async (queryArg: unknown, params: unknown[] = []) => {
        const text = typeof queryArg === 'string' ? queryArg : (queryArg as { text: string }).text
        const n = text.replace(/\s+/g, ' ').trim().toLowerCase()
        if (n === 'begin') return { rows: [], rowCount: 0 }
        if (n === 'commit' || n === 'rollback') {
          releaseLock?.()
          releaseLock = null
          return { rows: [], rowCount: 0 }
        }
        if (n.includes('pg_advisory_xact_lock')) {
          releaseLock = await acquireLock(String(params[0]))
          return { rows: [], rowCount: 0 }
        }
        if (n.includes('select') && n.includes('from climate_cells')) {
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
        }
        if (n.includes('insert into climate_cells')) {
          inserted.push(params)
          row = {
            summer_avg_temp_c: String(params[2]),
            winter_avg_temp_c: String(params[3]),
            annual_precip_mm: params[4],
            frost_days: params[5],
            monthly: JSON.parse(params[6] as string),
            source_version: params[7],
            fetched_at: '2026-08-06T00:00:00.000Z',
          }
          return { rows: [], rowCount: 1 }
        }
        throw new Error(`unexpected query: ${text}`)
      })
    }

    // drizzle's transaction() (withCellLock) only checks out its own
    // connection when the object it wraps looks like a `pg.Pool` — it tests
    // `instanceof Pool` or a constructor name containing "Pool" — so this
    // needs a named constructor to take that branch and give each concurrent
    // lock attempt its own `makeQuery()` closure, matching a real per-session
    // connection.
    function MockPool() {}
    const query = makeQuery()
    const connect = vi.fn(async () => ({ query: makeQuery(), release: vi.fn() }))
    const pool = Object.assign(new (MockPool as unknown as new () => object)(), { query, connect, inserted })
    return pool as unknown as Pool & { inserted: unknown[][] }
  }

  it('fetches, aggregates and caches on a miss', async () => {
    const db = fakePool(null)
    const fetchImpl = vi.fn<typeof fetch>(async () => buildSampleArchiveResponse())

    const normals = await readClimateNormals({ lat: 48.137, lng: 11.575 }, {
      db, checkedAt: '2026-08-06T00:00:00.000Z', fetchImpl,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const url = new URL(fetchImpl.mock.calls[0]![0] as string)
    expect(url.searchParams.get('latitude')).toBe('48.10')
    expect(url.searchParams.get('longitude')).toBe('11.50')
    expect(url.searchParams.get('start_date')).toBe('1991-01-01')
    expect(url.searchParams.get('end_date')).toBe('2020-12-31')

    expect(normals?.periodStartYear).toBe(1991)
    expect(normals?.months).toHaveLength(12)
    expect((db as unknown as { inserted: unknown[][] }).inserted).toHaveLength(1)
  })

  it('serializes concurrent misses on the same cold cell so only one fetch happens', async () => {
    const db = fakePool(null)
    const fetchImpl = vi.fn<typeof fetch>(async () => buildSampleArchiveResponse())

    // Two nearby auctions that round to the same 0.1° cell, enriched at the
    // same time (e.g. two different external-enrichment runs overlapping).
    const [first, second] = await Promise.all([
      readClimateNormals({ lat: 48.137, lng: 11.575 }, { db, checkedAt: '2026-08-06T00:00:00.000Z', fetchImpl }),
      readClimateNormals({ lat: 48.161, lng: 11.599 }, { db, checkedAt: '2026-08-06T00:00:00.000Z', fetchImpl }),
    ])

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(first?.months).toHaveLength(12)
    expect(second?.months).toHaveLength(12)
    expect((db as unknown as { inserted: unknown[][] }).inserted).toHaveLength(1)
  })

  it('serves a fresh cached cell without calling fetch again', async () => {
    const db = fakePool({
      summer_avg_temp_c: '28.5',
      winter_avg_temp_c: '-2.8',
      annual_precip_mm: 139,
      frost_days: 3,
      monthly: aggregate(buildSampleDaily()).monthly,
      source_version: OPEN_METEO_CLIMATE_SOURCE_VERSION,
      fetched_at: '2026-01-01T00:00:00.000Z',
    })
    const fetchImpl = vi.fn<typeof fetch>(async () => buildSampleArchiveResponse())

    const normals = await readClimateNormals({ lat: 48.137, lng: 11.575 }, {
      db, checkedAt: '2026-08-06T00:00:00.000Z', fetchImpl,
    })

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(normals?.months).toHaveLength(12)
  })

  it('refetches when the cached row carries an older source version', async () => {
    const db = fakePool({
      summer_avg_temp_c: '28.5',
      winter_avg_temp_c: '-2.8',
      annual_precip_mm: 139,
      frost_days: 3,
      monthly: aggregate(buildSampleDaily()).monthly,
      source_version: 'open-meteo-era5-land-1981-2010-v1',
      fetched_at: '2020-01-01T00:00:00.000Z',
    })
    const fetchImpl = vi.fn<typeof fetch>(async () => buildSampleArchiveResponse())

    await readClimateNormals({ lat: 48.137, lng: 11.575 }, {
      db, checkedAt: '2026-08-06T00:00:00.000Z', fetchImpl,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rejects and does not cache a response with a short metric vector', async () => {
    const db = fakePool(null)
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      daily: {
        time: ['2020-01-01', '2020-01-02'],
        temperature_2m_max: [5, 6],
        temperature_2m_min: [1, 2],
        // one entry short of `time` -> the whole response is incomplete
        temperature_2m_mean: [3],
        precipitation_sum: [0, 0],
      },
    }), { status: 200 }))

    const normals = await readClimateNormals({ lat: 48.137, lng: 11.575 }, {
      db, checkedAt: '2026-08-06T00:00:00.000Z', fetchImpl,
    })

    expect(normals).toBeNull()
    expect((db as unknown as { inserted: unknown[][] }).inserted).toHaveLength(0)
  })

  it('applies the normals to the environment context and extends source attribution', async () => {
    const db = fakePool(null)
    const enhancer = createOpenMeteoClimateNormalsEnhancer({
      db,
      checkedAt: '2026-08-06T00:00:00.000Z',
      fetchImpl: vi.fn<typeof fetch>(async () => buildSampleArchiveResponse()),
    })

    const enhanced = await enhancer.enhance(auction(), context())

    expect(enhanced.environment.climateNormals?.months).toHaveLength(12)
    expect(enhanced.source.label).toContain('Open-Meteo')
  })

  it('stays unsupported without coordinates', () => {
    const enhancer = createOpenMeteoClimateNormalsEnhancer({
      db: fakePool(null),
      checkedAt: '2026-08-06T00:00:00.000Z',
    })

    expect(enhancer.supports(auction(), context())).toBe(true)
    expect(enhancer.supports(auction({ lat: null, lng: null }), context())).toBe(false)
  })
})

describe('applyClimateNormals', () => {
  it('leaves other environment fields untouched', () => {
    const original = context()
    const normals = {
      periodStartYear: 1991,
      periodEndYear: 2020,
      months: aggregate(buildSampleDaily()).monthly,
      sourceLabel: 'Open-Meteo',
      sourceUrl: 'https://open-meteo.com/en/docs/historical-weather-api',
      checkedAt: '2026-08-06T00:00:00.000Z',
    }

    const applied = applyClimateNormals(original, normals)

    expect(applied.environment.climateNormals).toBe(normals)
    expect(applied.environment.riskSignals).toBe(original.environment.riskSignals)
  })
})
