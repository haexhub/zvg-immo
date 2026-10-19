import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import type { AuctionKey, AuctionRecord } from '~/server/utils/auction-record'
import { getPool } from '~/server/utils/db'

vi.mock('~/server/utils/db', () => ({ getPool: vi.fn() }))
vi.mock('~/server/crawlers/registry', () => ({
  ensureEnabledCountriesLoaded: vi.fn(async () => ['de']),
  crawlAll: vi.fn(),
}))
vi.mock('~/server/utils/geocode', () => ({
  activeGeocoderProvider: vi.fn(() => 'nominatim'),
  geocodeAddress: vi.fn(),
  geocodeStatus: vi.fn(async () => 'unresolvable'),
}))
vi.mock('~/server/utils/auction-record', async (importOriginal) => ({
  ...await importOriginal<typeof import('~/server/utils/auction-record')>(),
  readAuctionRecordsByKeys: vi.fn(),
}))
vi.mock('~/server/utils/current-auctions', async (importOriginal) => ({
  ...await importOriginal<typeof import('~/server/utils/current-auctions')>(),
  recordGeocodeAttempts: vi.fn(async () => undefined),
  upsertCurrentAuctions: vi.fn(async () => undefined),
}))
vi.mock('./geocode-verkehrswert', () => ({
  enrichStoredVerkehrswert: vi.fn(async () => ({ at: { added: 2, errors: 1 }, be: { added: 3, errors: 0 } })),
}))
vi.mock('~/server/tasks/external-enrichment', () => ({ runExternalEnrichment: vi.fn(async () => ({})) }))

const { crawlAll } = await import('~/server/crawlers/registry')
const { geocodeAddress } = await import('~/server/utils/geocode')
const auctionRecord = await import('~/server/utils/auction-record')
const currentAuctions = await import('~/server/utils/current-auctions')
const { enrichStoredVerkehrswert } = await import('./geocode-verkehrswert')
const { COORDINATE_FLUSH_SIZE, findGeocodeCandidates, persistResolvedCoordinates, runGeocode } = await import('./geocode-run')

const readAuctionRecordsByKeys = vi.mocked(auctionRecord.readAuctionRecordsByKeys)
const upsertCurrentAuctions = vi.mocked(currentAuctions.upsertCurrentAuctions)
const recordGeocodeAttempts = vi.mocked(currentAuctions.recordGeocodeAttempts)

function makeAuction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'zvg-portal',
    country: 'de',
    region: 'Brandenburg',
    externalId: '1',
    caseNumber: '7 K 1/25',
    authority: 'Neuruppin',
    title: 'Einfamilienhaus',
    address: 'Berliner Tor 2, 16278 Angermünde',
    marketValueEur: null,
    marketValueText: null,
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
    lat: null,
    lng: null,
    ...overrides,
  }
}

function candidateRow(externalId: string) {
  return { platform: 'zvg-portal', external_id: externalId, country: 'de', address: `Straße ${externalId}, Berlin` }
}

/** Records as the store would return them: one per requested key, with the
 *  stored (still coordinate-less) auction. */
function storeRecords(overrides: Record<string, Partial<Auction>> = {}) {
  readAuctionRecordsByKeys.mockImplementation(async (keys: readonly AuctionKey[]) => new Map(keys.map((key) => [
    `${key.platform}:${key.externalId}`,
    {
      auction: makeAuction({ platform: key.platform, externalId: key.externalId, ...overrides[key.externalId] }),
      detailsId: 1,
      detailsVersion: 1,
      artifactVersionId: null,
    } satisfies AuctionRecord,
  ])))
}

const query = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getPool).mockReturnValue({ query } as never)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

describe('findGeocodeCandidates', () => {
  it('selects current, uncancelled, coordinate-less auctions with an address from the store', async () => {
    query.mockResolvedValueOnce({ rows: [candidateRow('1')] })
    const rows = await findGeocodeCandidates(['de'])
    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain('a.cancelled = false')
    expect(sql).toContain('a.lat IS NULL OR a.lng IS NULL OR (a.lat = 0 AND a.lng = 0)')
    expect(sql).toContain('d.is_latest = true')
    expect(sql).toContain('a.auction_date_iso IS NULL OR a.auction_date_iso >= now()')
    expect(sql).toContain('a.last_seen_at < cs.last_success_at')
    expect(sql).toMatch(/ORDER BY a\.geocode_attempted_at ASC NULLS FIRST/)
    expect(params).toEqual([['de']])
    expect(rows).toEqual([{ platform: 'zvg-portal', externalId: '1', country: 'de', address: 'Straße 1, Berlin' }])
  })

  it('returns nothing without countries or a database', async () => {
    expect(await findGeocodeCandidates([])).toEqual([])
    vi.mocked(getPool).mockReturnValue(null as never)
    expect(await findGeocodeCandidates(['de'])).toEqual([])
    expect(query).not.toHaveBeenCalled()
  })
})

describe('runGeocode', () => {
  it('never crawls and persists only the auctions resolved in this run', async () => {
    query.mockResolvedValueOnce({ rows: [candidateRow('1'), candidateRow('2'), candidateRow('3')] })
    vi.mocked(geocodeAddress).mockImplementation(async (address) =>
      address === 'Straße 2, Berlin' ? { lat: 52.5, lng: 13.4, displayName: 'x' } : null)
    storeRecords()

    const { result } = await runGeocode(new AbortController().signal)

    expect(crawlAll).not.toHaveBeenCalled()
    expect(geocodeAddress).toHaveBeenCalledTimes(3)
    expect(geocodeAddress).toHaveBeenCalledWith('Straße 1, Berlin', 'de', { fetchMissing: true })
    // Records are read only for the hit, by key — never for the misses.
    expect(readAuctionRecordsByKeys).toHaveBeenCalledTimes(1)
    expect(readAuctionRecordsByKeys.mock.calls[0]![0]).toEqual([
      { platform: 'zvg-portal', externalId: '2', lat: 52.5, lng: 13.4 },
    ])
    expect(upsertCurrentAuctions).toHaveBeenCalledTimes(1)
    const persisted = upsertCurrentAuctions.mock.calls[0]![0]
    expect(persisted.map((a) => [a.externalId, a.lat, a.lng, a.title])).toEqual([['2', 52.5, 13.4, 'Einfamilienhaus']])
    expect(recordGeocodeAttempts.mock.calls[0]![0].map((a) => [a.externalId, a.result])).toEqual([
      ['1', 'unresolvable'], ['2', 'geocoded'], ['3', 'unresolvable'],
    ])
    expect(enrichStoredVerkehrswert).toHaveBeenCalledWith(['de'], expect.any(AbortSignal))
    expect(result).toEqual(expect.objectContaining({
      processed: 3,
      geocoded: 1,
      persistedCoordinates: 1,
      failed: 0,
      verkehrswertAdded: 5,
      verkehrswertErrors: 1,
    }))
  })

  it('loads records and writes coordinates in bounded chunks', async () => {
    const total = COORDINATE_FLUSH_SIZE + 20
    query.mockResolvedValueOnce({ rows: Array.from({ length: total }, (_, i) => candidateRow(String(i))) })
    vi.mocked(geocodeAddress).mockResolvedValue({ lat: 48.1, lng: 11.5, displayName: 'x' })
    storeRecords()

    const { result } = await runGeocode(new AbortController().signal)

    expect(readAuctionRecordsByKeys.mock.calls.map(([keys]) => keys.length)).toEqual([COORDINATE_FLUSH_SIZE, 20])
    expect(upsertCurrentAuctions.mock.calls.map(([auctions]) => auctions.length)).toEqual([COORDINATE_FLUSH_SIZE, 20])
    expect(result.persistedCoordinates).toBe(total)
  })

  it('keeps what an aborted run resolved and skips the verkehrswert pass', async () => {
    const controller = new AbortController()
    query.mockResolvedValueOnce({ rows: [candidateRow('1'), candidateRow('2')] })
    vi.mocked(geocodeAddress).mockImplementation(async () => {
      controller.abort(new Error('superseded'))
      return { lat: 50, lng: 8, displayName: 'x' }
    })
    storeRecords()

    await expect(runGeocode(controller.signal)).rejects.toThrow('superseded')

    expect(upsertCurrentAuctions.mock.calls[0]![0].map((a) => a.externalId)).toEqual(['1'])
    expect(recordGeocodeAttempts).toHaveBeenCalledTimes(1)
    expect(enrichStoredVerkehrswert).not.toHaveBeenCalled()
  })
})

describe('persistResolvedCoordinates', () => {
  it('leaves a position a crawler supplied in the meantime alone, and skips vanished auctions', async () => {
    storeRecords({ '1': { lat: 51, lng: 7 }, '2': { lat: 0, lng: 0 } })
    const written = await persistResolvedCoordinates([
      { platform: 'zvg-portal', externalId: '1', lat: 52, lng: 13 },
      { platform: 'zvg-portal', externalId: '2', lat: 53, lng: 10 },
    ])
    expect(written).toBe(1)
    expect(upsertCurrentAuctions.mock.calls[0]![0].map((a) => [a.externalId, a.lat, a.lng])).toEqual([['2', 53, 10]])

    readAuctionRecordsByKeys.mockResolvedValueOnce(new Map())
    expect(await persistResolvedCoordinates([{ platform: 'zvg-portal', externalId: '9', lat: 1, lng: 1 }])).toBe(0)
  })
})

// Real Postgres: the candidate SQL and the record round trip are only proven
// against the actual schema. Skipped without TEST_DATABASE_URL. Fixture rows
// live under their own country/platform and are removed again.
const TEST_DB = process.env.TEST_DATABASE_URL
const describeDb = TEST_DB ? describe : describe.skip

describeDb('geocode store path (real Postgres)', () => {
  const COUNTRY = 'zz-geocode-run-test'
  const PLATFORM = 'zz-geocode-run-test-platform'
  let pool: import('pg').Pool

  async function cleanup() {
    await pool.query('DELETE FROM auctions WHERE platform = $1', [PLATFORM])
  }

  async function seed(
    externalId: string,
    opts: { address?: string | null; lat?: number | null; lng?: number | null; cancelled?: boolean; date?: string | null; attemptedAt?: string | null } = {},
  ) {
    await pool.query(
      `INSERT INTO auctions (platform, external_id, country, region, authority, case_number, title, cancelled,
                             auction_date_iso, lat, lng, geocode_attempted_at)
       VALUES ($1, $2, $3, 'Region', 'Gericht', 'K 1', 'Titel ' || $2, $4, $5, $6, $7, $8)`,
      [PLATFORM, externalId, COUNTRY, opts.cancelled ?? false, opts.date ?? null, opts.lat ?? null, opts.lng ?? null, opts.attemptedAt ?? null],
    )
    if (opts.address !== undefined) {
      await pool.query(
        `INSERT INTO auction_details (platform, external_id, version, extracted_at, address, is_latest)
         VALUES ($1, $2, 1, now(), $3, true)`,
        [PLATFORM, externalId, opts.address],
      )
    }
  }

  beforeAll(async () => {
    const { Pool } = await import('pg')
    pool = new Pool({ connectionString: TEST_DB })
  })

  beforeEach(async () => {
    vi.mocked(getPool).mockReturnValue(pool as never)
    readAuctionRecordsByKeys.mockImplementation(
      (await vi.importActual<typeof import('~/server/utils/auction-record')>('~/server/utils/auction-record')).readAuctionRecordsByKeys,
    )
    upsertCurrentAuctions.mockImplementation(
      (await vi.importActual<typeof import('~/server/utils/current-auctions')>('~/server/utils/current-auctions')).upsertCurrentAuctions,
    )
    await cleanup()
  })

  afterEach(cleanup)
  afterAll(async () => {
    await pool.end()
  })

  it('selects only current, uncancelled auctions with an address and no usable position', async () => {
    await seed('never', { address: 'Hauptstr. 1' })
    await seed('older-attempt', { address: 'Hauptstr. 2', attemptedAt: '2026-01-01T00:00:00Z' })
    await seed('null-island', { address: 'Hauptstr. 3', lat: 0, lng: 0, attemptedAt: '2026-06-01T00:00:00Z' })
    await seed('has-coords', { address: 'Hauptstr. 4', lat: 52, lng: 13 })
    await seed('cancelled', { address: 'Hauptstr. 5', cancelled: true })
    await seed('expired', { address: 'Hauptstr. 6', date: '2020-01-01T00:00:00Z' })
    await seed('blank-address', { address: '  ' })
    await seed('no-details')

    const rows = await findGeocodeCandidates([COUNTRY])
    expect(rows.map((row) => row.externalId)).toEqual(['never', 'older-attempt', 'null-island'])
    expect(rows[0]).toEqual({ platform: PLATFORM, externalId: 'never', country: COUNTRY, address: 'Hauptstr. 1' })
  })

  it('writes the resolved position without touching the identity fields', async () => {
    await seed('a', { address: 'Hauptstr. 1', date: '2099-05-01T10:00:00Z' })
    await seed('b', { address: 'Hauptstr. 2', lat: 51, lng: 7 })

    const written = await persistResolvedCoordinates([
      { platform: PLATFORM, externalId: 'a', lat: 52.25, lng: 13.5 },
      { platform: PLATFORM, externalId: 'b', lat: 1, lng: 1 },
    ])

    expect(written).toBe(1)
    const { rows } = await pool.query<{ external_id: string; lat: string; lng: string; title: string; auction_date_iso: Date; cancelled: boolean }>(
      'SELECT external_id, lat, lng, title, auction_date_iso, cancelled FROM auctions WHERE platform = $1 ORDER BY external_id',
      [PLATFORM],
    )
    expect(rows.map((row) => [row.external_id, Number(row.lat), Number(row.lng), row.title, row.cancelled])).toEqual([
      ['a', 52.25, 13.5, 'Titel a', false],
      ['b', 51, 7, 'Titel b', false],
    ])
    expect(rows[0]!.auction_date_iso.toISOString()).toBe('2099-05-01T10:00:00.000Z')
    const versions = await pool.query('SELECT 1 FROM auction_details WHERE platform = $1', [PLATFORM])
    expect(versions.rowCount).toBe(2)
  })
})
