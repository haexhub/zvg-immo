import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction, AuctionExtraction } from '~/types/auction'
import { getPool } from './db'

vi.mock('./db', () => ({ getPool: vi.fn() }))

const { auctionDetailsValues, invalidateAuctionDetailsCache, readAuctionDetailsAtVersion, readLatestAuctionDetails, writeAuctionDetails } =
  await import('./auction-details')

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
    marketValueEur: 250000,
    marketValueText: null,
    auctionDateIso: '2026-10-15T14:00:00.000Z',
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
    ...overrides,
  }
}

function makeExtraction(overrides: Partial<AuctionExtraction> = {}): AuctionExtraction {
  return {
    propertyType: 'einfamilienhaus',
    landAreaSqm: 500,
    livingAreaSqm: 120,
    rooms: 4,
    units: 1,
    source: 'llm',
    confidence: 'high',
    at: '2026-08-01T10:00:00.000Z',
    ...overrides,
  }
}

describe('auctionDetailsValues', () => {
  it('projects auction and extraction fields onto the value columns', () => {
    const values = auctionDetailsValues(
      makeAuction({ startingBid: 1000, lat: 52.1, lng: 13.2 }),
      makeExtraction({ heating: 'Gaszentralheizung', yearBuilt: 1968 }),
    )

    expect(values).toMatchObject({
      address: 'Berliner Tor 2, 16278 Angermünde',
      property_type: 'einfamilienhaus',
      land_area_sqm: 500,
      living_area_sqm: 120,
      rooms: 4,
      units: 1,
      heating: 'Gaszentralheizung',
      year_built: 1968,
      market_value_eur: 250000,
      starting_bid: 1000,
      lat: 52.1,
      lng: 13.2,
      extraction_source: 'llm',
      extraction_confidence: 'high',
    })
  })

  it('JSON-encodes the jsonb columns and leaves absent extraction fields null', () => {
    const values = auctionDetailsValues(makeAuction(), makeExtraction({ condition: 'gepflegt' }))
    expect(values.condition).toBe('"gepflegt"')
    expect(values.insights).toBeNull()
    expect(values.planning_notes).toBeNull()
  })

  it('tolerates a missing extraction, keeping the auction-level fields', () => {
    const values = auctionDetailsValues(makeAuction({ photoCount: 3 }), null)
    expect(values.property_type).toBeNull()
    expect(values.photo_count).toBe(3)
    expect(values.address).toBe('Berliner Tor 2, 16278 Angermünde')
  })
})

// Versioning is enforced by Postgres (advisory lock + UNIQUE constraint), so
// these need a real database rather than a fake pool. Skipped unless one is
// configured; see the WP-2 PR for the recorded run.
const TEST_DB = process.env.TEST_DATABASE_URL
const describeDb = TEST_DB ? describe : describe.skip

describeDb('writeAuctionDetails (real Postgres)', () => {
  let pool: import('pg').Pool

  beforeAll(async () => {
    const { Pool } = await import('pg')
    pool = new Pool({ connectionString: TEST_DB })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    vi.mocked(getPool).mockReturnValue(pool as never)
    invalidateAuctionDetailsCache()
    await pool.query('DELETE FROM auction_details')
    await pool.query('DELETE FROM auctions')
    await pool.query(
      `INSERT INTO auctions (platform, external_id, country, region, authority, case_number, cancelled)
       VALUES ('zvg-portal', '7265', 'de', 'Brandenburg', 'Neuruppin', '7 K 168/25', false)`,
    )
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('starts at version 1 and appends a new version when a value changes', async () => {
    const first = await writeAuctionDetails(makeAuction(), makeExtraction())
    expect(first).toEqual({ version: 1, changed: true })

    const second = await writeAuctionDetails(makeAuction(), makeExtraction({ livingAreaSqm: 140 }))
    expect(second).toEqual({ version: 2, changed: true })

    const latest = await readLatestAuctionDetails('zvg-portal', '7265')
    expect(Number(latest?.living_area_sqm)).toBe(140)

    // The old version is untouched — that is the whole point of the table.
    const v1 = await readAuctionDetailsAtVersion('zvg-portal', '7265', 1)
    expect(Number(v1?.living_area_sqm)).toBe(120)
  })

  it('skips the insert when nothing actually changed', async () => {
    await writeAuctionDetails(makeAuction(), makeExtraction())
    // Same values, later extraction timestamp: a re-run that found the same
    // facts must not grow the history.
    const repeat = await writeAuctionDetails(makeAuction(), makeExtraction({ at: '2026-08-02T10:00:00.000Z' }))
    expect(repeat).toEqual({ version: 1, changed: false })

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM auction_details')
    expect(rows[0].n).toBe(1)
  })

  it('serializes concurrent writers for the same auction into consecutive versions', async () => {
    await writeAuctionDetails(makeAuction(), makeExtraction())

    // Distinct values each, so changed-detection lets all of them through and
    // the advisory lock is the only thing that can serialize the
    // MAX(version)+1 read against the INSERT. Two writers rarely overlap in
    // practice; this many reliably do, and without the lock they collide on
    // UNIQUE (platform, external_id, version).
    const WRITERS = 8
    const results = await Promise.all(
      Array.from({ length: WRITERS }, (_, i) =>
        writeAuctionDetails(makeAuction(), makeExtraction({ livingAreaSqm: 200 + i })),
      ),
    )

    expect(results.map((r) => r!.version).sort((a, b) => a - b)).toEqual(
      Array.from({ length: WRITERS }, (_, i) => i + 2),
    )
    const { rows } = await pool.query<{ version: number }>(
      'SELECT version FROM auction_details ORDER BY version',
    )
    expect(rows.map((r) => r.version)).toEqual(Array.from({ length: WRITERS + 1 }, (_, i) => i + 1))
  })

  it('holds the advisory lock for the whole transaction', async () => {
    await writeAuctionDetails(makeAuction(), makeExtraction())

    const blocker = await pool.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        'auction_details:zvg-portal:7265',
      ])

      let settled = false
      const pending = writeAuctionDetails(makeAuction(), makeExtraction({ livingAreaSqm: 999 }))
        .then((r) => {
          settled = true
          return r
        })
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(settled).toBe(false) // blocked on the lock the blocker holds

      await blocker.query('COMMIT')
      expect(await pending).toEqual({ version: 2, changed: true })
    } finally {
      blocker.release()
    }
  })
})
