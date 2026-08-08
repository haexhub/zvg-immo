import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import { getPool } from './db'

vi.mock('./db', () => ({ getPool: vi.fn() }))
vi.mock('~/server/tasks/external-enrichment', () => ({ runExternalEnrichment: vi.fn(async () => ({})) }))

const { runExternalEnrichment } = await import('~/server/tasks/external-enrichment')

const {
  auctionToCurrentRow,
  coordinatesMovedSignificantly,
  ensureAuctionIdentity,
  recordGeocodeAttempts,
  upsertCurrentAuctions,
} = await import('./current-auctions')

function makeAuction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'zvg-portal',
    country: 'de',
    region: 'Brandenburg',
    externalId: '7265',
    caseNumber: '7 K 168/25',
    authority: 'Neuruppin',
    title: 'gewerblich genutztes Grundstück',
    address: 'Berliner Tor 2, 16278 Angermünde',
    marketValueEur: null,
    marketValueText: null,
    auctionDateIso: '2026-10-15T14:00:00.000Z',
    auctionDateText: '15.10.2026, 16:00 Uhr',
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
    ...overrides,
  }
}

/** A pool-like mock whose query() routes on SQL shape: the previous-coordinates
 *  SELECT (against previousRows) vs. the identity INSERT/upsert. */
function mockPool(previousRows: Array<{ platform: string; external_id: string; lat: number | string | null; lng: number | string | null }>) {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.startsWith('SELECT platform, external_id, lat, lng')) return { rows: previousRows }
    return { rows: [], rowCount: 1, values }
  })
  return { query }
}

describe('auction identity persistence', () => {
  it('projects only identity, scheduling and coordinate fields', () => {
    const row = auctionToCurrentRow(makeAuction({
      marketValueEur: 250000,
      lat: 52.1,
      lng: 13.2,
      extraction: {
        propertyType: 'einfamilienhaus',
        landAreaSqm: 500,
        livingAreaSqm: 120,
        rooms: 4,
        units: 1,
        source: 'llm',
        confidence: 'high',
        at: '2026-08-02T10:00:00.000Z',
      },
    }), '2026-08-02T11:00:00.000Z')

    expect(row).toEqual({
      platform: 'zvg-portal',
      external_id: '7265',
      country: 'de',
      region: 'Brandenburg',
      authority: 'Neuruppin',
      case_number: '7 K 168/25',
      title: 'gewerblich genutztes Grundstück',
      auction_date_iso: '2026-10-15T14:00:00.000Z',
      auction_date_text: '15.10.2026, 16:00 Uhr',
      cancelled: false,
      lat: 52.1,
      lng: 13.2,
      updated_at: '2026-08-02T11:00:00.000Z',
    })
    expect(row).not.toHaveProperty('address')
    expect(row).not.toHaveProperty('property_type')
    expect(row).not.toHaveProperty('market_value_eur')
  })

  it('defaults lat/lng to null when the auction has no coordinates yet', () => {
    const row = auctionToCurrentRow(makeAuction(), '2026-08-02T11:00:00.000Z')
    expect(row.lat).toBeNull()
    expect(row.lng).toBeNull()
  })

  it('upserts deduplicated identities with last-wins values', async () => {
    const pool = mockPool([])
    vi.mocked(getPool).mockReturnValue(pool as never)

    await upsertCurrentAuctions([
      makeAuction({ title: 'old' }),
      makeAuction({ title: 'new', cancelled: true }),
    ], '2026-08-02T11:00:00.000Z')

    // One SELECT for the previous coordinates, one INSERT ... ON CONFLICT.
    expect(pool.query).toHaveBeenCalledTimes(2)
    const upsertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO auctions'))
    expect(upsertCall?.[0]).toContain('ON CONFLICT (platform, external_id) DO UPDATE SET')
    expect(upsertCall?.[1]).toHaveLength(13)
    expect(upsertCall?.[1]).toContain('new')
    expect(upsertCall?.[1]).not.toContain('old')
  })

  it('creates prerequisite identities without updating existing rows, and does not check coordinates', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 })
    vi.mocked(getPool).mockReturnValue({ query } as never)

    await ensureAuctionIdentity([makeAuction()])

    // Just the INSERT — ensureAuctionIdentity never diffs coordinates or
    // triggers re-enrichment, that only happens after a real crawl/geocode run.
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]?.[0]).toContain('ON CONFLICT (platform, external_id) DO NOTHING')
  })

  it('is a no-op without a configured pool', async () => {
    vi.mocked(getPool).mockReturnValue(null)
    await expect(upsertCurrentAuctions([makeAuction()], '2026-08-02T11:00:00.000Z')).resolves.toBeUndefined()
  })

  it('surfaces query failures', async () => {
    vi.mocked(getPool).mockReturnValue({
      query: vi.fn().mockRejectedValue(new Error('connection reset')),
    } as never)

    await expect(upsertCurrentAuctions([makeAuction()], '2026-08-02T11:00:00.000Z'))
      .rejects.toThrow('connection reset')
  })
})

describe('recordGeocodeAttempts', () => {
  it('updates geocode_attempted_at/result/provider by identity', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    vi.mocked(getPool).mockReturnValue({ query } as never)

    await recordGeocodeAttempts([
      { platform: 'se-kronofogden', externalId: '101782', result: 'geocoded', provider: 'nominatim' },
      { platform: 'se-kronofogden', externalId: '101877', result: 'unresolvable', provider: 'nominatim' },
    ], '2026-08-05T10:00:00.000Z')

    expect(query).toHaveBeenCalledTimes(1)
    const [sql, values] = query.mock.calls[0]!
    expect(sql).toContain('UPDATE auctions SET')
    expect(sql).toContain('geocode_attempted_at = v.attempted_at')
    expect(sql).toContain('geocode_result = v.result')
    expect(sql).toContain('geocode_provider = v.provider')
    expect(values).toEqual([
      'se-kronofogden', '101782', '2026-08-05T10:00:00.000Z', 'geocoded', 'nominatim',
      'se-kronofogden', '101877', '2026-08-05T10:00:00.000Z', 'unresolvable', 'nominatim',
    ])
  })

  it('is a no-op without a configured pool or with no attempts', async () => {
    vi.mocked(getPool).mockReturnValue(null)
    await expect(recordGeocodeAttempts(
      [{ platform: 'a', externalId: 'b', result: 'pending', provider: 'locationiq' }],
      '2026-08-05T10:00:00.000Z',
    )).resolves.toBeUndefined()

    const query = vi.fn()
    vi.mocked(getPool).mockReturnValue({ query } as never)
    await recordGeocodeAttempts([], '2026-08-05T10:00:00.000Z')
    expect(query).not.toHaveBeenCalled()
  })
})

describe('coordinatesMovedSignificantly', () => {
  it('treats the first coordinates an auction ever gets as a move', () => {
    expect(coordinatesMovedSignificantly(null, { lat: 52.1, lng: 13.2 })).toBe(true)
    expect(coordinatesMovedSignificantly({ lat: null, lng: null }, { lat: 52.1, lng: 13.2 })).toBe(true)
  })

  it('ignores geocoder noise below the threshold', () => {
    // ~11 m apart.
    expect(coordinatesMovedSignificantly({ lat: 52.1, lng: 13.2 }, { lat: 52.1001, lng: 13.2 })).toBe(false)
    expect(coordinatesMovedSignificantly({ lat: 52.1, lng: 13.2 }, { lat: 52.1, lng: 13.2 })).toBe(false)
  })

  it('reports a real relocation', () => {
    // ~1.1 km apart.
    expect(coordinatesMovedSignificantly({ lat: 52.1, lng: 13.2 }, { lat: 52.11, lng: 13.2 })).toBe(true)
  })

  it('does not fire when the new version lost its coordinates', () => {
    expect(coordinatesMovedSignificantly({ lat: 52.1, lng: 13.2 }, { lat: null, lng: null })).toBe(false)
  })
})

describe('upsertCurrentAuctions location-enrichment trigger', () => {
  it('triggers targeted location enrichment only when coordinates really moved', async () => {
    const mockedRunExternalEnrichment = vi.mocked(runExternalEnrichment)
    mockedRunExternalEnrichment.mockClear()

    // First run: no previous row at all — first coordinates ever, must trigger.
    vi.mocked(getPool).mockReturnValue(mockPool([]) as never)
    await upsertCurrentAuctions([makeAuction({ lat: 52.1, lng: 13.2 })], '2026-08-02T11:00:00.000Z')
    // Fire-and-forget: let the microtask queue drain before asserting.
    await Promise.resolve()
    expect(mockedRunExternalEnrichment).toHaveBeenCalledWith(
      { platform: 'zvg-portal', externalId: '7265' },
      expect.any(AbortSignal),
    )

    // Second run: coordinates only jittered — must not re-enrich.
    mockedRunExternalEnrichment.mockClear()
    vi.mocked(getPool).mockReturnValue(
      mockPool([{ platform: 'zvg-portal', external_id: '7265', lat: '52.1', lng: '13.2' }]) as never,
    )
    await upsertCurrentAuctions([makeAuction({ lat: 52.1001, lng: 13.2 })], '2026-08-02T11:00:00.000Z')
    await Promise.resolve()
    expect(mockedRunExternalEnrichment).not.toHaveBeenCalled()

    // Third run: a real relocation — must re-enrich.
    vi.mocked(getPool).mockReturnValue(
      mockPool([{ platform: 'zvg-portal', external_id: '7265', lat: '52.1001', lng: '13.2' }]) as never,
    )
    await upsertCurrentAuctions([makeAuction({ lat: 52.11, lng: 13.2 })], '2026-08-02T11:00:00.000Z')
    await Promise.resolve()
    expect(mockedRunExternalEnrichment).toHaveBeenCalledTimes(1)
  })
})

// Real Postgres, not a fake pool: a mocked query() can't catch a write
// referencing a column that doesn't exist on the actual table (exactly what
// happened here — WP-0 moved lat/lng onto auctions and this file's COLUMNS
// simply didn't carry them, so nothing ever persisted a coordinate at all).
const TEST_DB = process.env.TEST_DATABASE_URL
const describeDb = TEST_DB ? describe : describe.skip

describeDb('upsertCurrentAuctions (real Postgres)', () => {
  let pool: import('pg').Pool

  beforeAll(async () => {
    const { Pool } = await import('pg')
    pool = new Pool({ connectionString: TEST_DB })
  })

  afterAll(async () => {
    await pool.end()
  })

  // A distinct identity, and a DELETE scoped to just it: auction-details.test.ts
  // runs its own real-DB suite against 'zvg-portal:7265' concurrently (vitest
  // runs test files in parallel) — a blanket `DELETE FROM auctions` here would
  // race that file's tests and cascade-delete its auction_details rows mid-test.
  const TEST_IDENTITY = { platform: 'zvg-portal', externalId: 'current-auctions-test' }

  beforeEach(async () => {
    vi.mocked(getPool).mockReturnValue(pool as never)
    await pool.query('DELETE FROM auctions WHERE platform = $1 AND external_id = $2', [
      TEST_IDENTITY.platform,
      TEST_IDENTITY.externalId,
    ])
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('persists lat/lng onto auctions and re-enriches only on a real relocation', async () => {
    const mockedRunExternalEnrichment = vi.mocked(runExternalEnrichment)
    await upsertCurrentAuctions([makeAuction({ ...TEST_IDENTITY, lat: 52.1, lng: 13.2 })], '2026-08-02T11:00:00.000Z')
    const { rows } = await pool.query<{ lat: string; lng: string }>(
      'SELECT lat, lng FROM auctions WHERE platform = $1 AND external_id = $2',
      [TEST_IDENTITY.platform, TEST_IDENTITY.externalId],
    )
    expect(Number(rows[0]?.lat)).toBe(52.1)
    expect(Number(rows[0]?.lng)).toBe(13.2)
    await Promise.resolve()
    expect(mockedRunExternalEnrichment).toHaveBeenCalledWith(
      { platform: TEST_IDENTITY.platform, externalId: TEST_IDENTITY.externalId },
      expect.any(AbortSignal),
    )

    mockedRunExternalEnrichment.mockClear()
    await upsertCurrentAuctions([makeAuction({ ...TEST_IDENTITY, lat: 52.11, lng: 13.2 })], '2026-08-02T12:00:00.000Z')
    const updated = await pool.query<{ lat: string }>(
      'SELECT lat FROM auctions WHERE platform = $1 AND external_id = $2',
      [TEST_IDENTITY.platform, TEST_IDENTITY.externalId],
    )
    expect(Number(updated.rows[0]?.lat)).toBe(52.11)
    await Promise.resolve()
    expect(mockedRunExternalEnrichment).toHaveBeenCalledTimes(1)
  })

  it('persists geocode_attempted_at/result/provider (WP-3 observability)', async () => {
    await upsertCurrentAuctions([makeAuction({ ...TEST_IDENTITY })], '2026-08-02T11:00:00.000Z')

    await recordGeocodeAttempts([
      { platform: TEST_IDENTITY.platform, externalId: TEST_IDENTITY.externalId, result: 'unresolvable', provider: 'nominatim' },
    ], '2026-08-05T09:00:00.000Z')

    const { rows } = await pool.query<{ geocode_attempted_at: Date; geocode_result: string; geocode_provider: string }>(
      'SELECT geocode_attempted_at, geocode_result, geocode_provider FROM auctions WHERE platform = $1 AND external_id = $2',
      [TEST_IDENTITY.platform, TEST_IDENTITY.externalId],
    )
    expect(rows[0]?.geocode_result).toBe('unresolvable')
    expect(rows[0]?.geocode_provider).toBe('nominatim')
    expect(rows[0]?.geocode_attempted_at?.toISOString()).toBe('2026-08-05T09:00:00.000Z')
  })
})
