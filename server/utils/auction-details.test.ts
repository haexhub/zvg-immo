import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction, AuctionExtraction } from '~/types/auction'
import { getPool } from './db'

vi.mock('./db', () => ({ getPool: vi.fn() }))

const {
  auctionDetailsValues,
  invalidateAuctionDetailsCache,
  readAuctionDetailsAtVersion,
  readLatestAuctionDetails,
  writeAuctionDetails,
} = await import('./auction-details')

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
      makeAuction({
        startingBid: 1000,
        sourceLivingAreaSqm: 121,
        sourceLandAreaSqm: 501,
        sourceRooms: 4.5,
      }),
      makeExtraction({ heating: 'Gaszentralheizung', yearBuilt: 1968, marketValueText: '250.000 EUR laut Gutachten' }),
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
      extraction_source: 'llm',
      extraction_confidence: 'high',
      source_living_area_sqm: 121,
      source_land_area_sqm: 501,
      source_rooms: 4.5,
      market_value_text: '250.000 EUR laut Gutachten',
    })
    // lat/lng live on auctions (WP-0), not the versioned auction_details.
    expect(values).not.toHaveProperty('lat')
    expect(values).not.toHaveProperty('lng')
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

// coordinatesMovedSignificantly and the location-enrichment trigger moved to
// current-auctions.ts with WP-0 (coordinates now live on auctions, not the
// versioned auction_details) — see current-auctions.test.ts.

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
    await pool.query('DELETE FROM artifact_versions')
    await pool.query('DELETE FROM auction_fetch_state')
    await pool.query('DELETE FROM location_enrichment')
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

  it('keeps is_latest true on exactly the newest version, demoting the previous one', async () => {
    // idx_auction_details_latest is a partial UNIQUE index (one true row per
    // identity) — appending a version without demoting the old one violates
    // it outright, so this is a correctness requirement, not a nicety.
    await writeAuctionDetails(makeAuction(), makeExtraction())
    await writeAuctionDetails(makeAuction(), makeExtraction({ livingAreaSqm: 140 }))
    await writeAuctionDetails(makeAuction(), makeExtraction({ livingAreaSqm: 160 }))

    const { rows } = await pool.query<{ version: number; is_latest: boolean }>(
      `SELECT version, is_latest FROM auction_details
       WHERE platform = 'zvg-portal' AND external_id = '7265' ORDER BY version`,
    )
    expect(rows).toEqual([
      { version: 1, is_latest: false },
      { version: 2, is_latest: false },
      { version: 3, is_latest: true },
    ])
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

  it('appends a version when only the curated photos changed', async () => {
    await writeAuctionDetails(
      makeAuction({ photoCount: 1 }),
      makeExtraction({ photos: [{ file: 'front.jpg', category: 'aussen', caption: null, isPropertyPhoto: true }] }),
    )
    const changed = await writeAuctionDetails(
      makeAuction({ photoCount: 1 }),
      makeExtraction({ photos: [{ file: 'front.jpg', category: 'innen', caption: 'Wohnzimmer', isPropertyPhoto: true }] }),
    )

    expect(changed).toEqual({ version: 2, changed: true })
    const { rows } = await pool.query(
      `SELECT d.version, p.category, p.caption
       FROM auction_details d JOIN auction_photos p ON p.auction_details_id = d.id
       ORDER BY d.version`,
    )
    expect(rows).toEqual([
      { version: 1, category: 'aussen', caption: null },
      { version: 2, category: 'innen', caption: 'Wohnzimmer' },
    ])
  })

  it('honors explicit parsed-manifest provenance for a rules-only placeholder', async () => {
    await pool.query(
      `INSERT INTO artifact_versions
         (platform, external_id, version, set_hash, document_count, captured_at, last_seen_at)
       VALUES
         ('zvg-portal', '7265', 1, 'first', 1, now(), now()),
         ('zvg-portal', '7265', 2, 'second', 1, now(), now())`,
    )
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM artifact_versions
       WHERE platform = 'zvg-portal' AND external_id = '7265' AND version = 1`,
    )
    const firstId = Number(rows[0]!.id)

    await writeAuctionDetails(
      makeAuction(),
      makeExtraction(),
      { artifactVersionId: firstId },
    )

    const details = await pool.query<{ artifact_version_id: string }>(
      `SELECT artifact_version_id FROM auction_details
       WHERE platform = 'zvg-portal' AND external_id = '7265'`,
    )
    expect(Number(details.rows[0]!.artifact_version_id)).toBe(firstId)
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

  it('cascades: deleting the referenced artifact_versions row deletes auction_details and its translations', async () => {
    // deleteRawArchiveCountry() deletes artifact_versions rows for a country
    // directly. ON DELETE CASCADE runs two layers deep (artifact_versions ->
    // auction_details -> auction_translations) precisely so that admin action
    // keeps working once a version is both extracted and translated, instead
    // of failing with an FK violation on whichever layer isn't cascaded.
    await pool.query(
      `INSERT INTO artifact_versions (platform, external_id, version, set_hash, document_count, captured_at, last_seen_at)
       VALUES ('zvg-portal', '7265', 1, 'deadbeef', 1, now(), now())`,
    )
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM artifact_versions WHERE platform = 'zvg-portal' AND external_id = '7265'`,
    )
    const write = await writeAuctionDetails(makeAuction(), makeExtraction(), {
      artifactVersionId: Number(rows[0]!.id),
    })
    expect(write).toEqual({ version: 1, changed: true })
    const before = await pool.query('SELECT artifact_version_id FROM auction_details WHERE version = 1')
    expect(before.rows[0].artifact_version_id).not.toBeNull()

    await pool.query(
      `INSERT INTO auction_translations (platform, external_id, version, lang, content_hash, status, title, started_at, completed_at)
       VALUES ('zvg-portal', '7265', 1, 'en', 'hash', 'completed', 'Test title', now(), now())`,
    )

    await pool.query(`DELETE FROM artifact_versions WHERE platform = 'zvg-portal' AND external_id = '7265'`)

    const details = await pool.query('SELECT count(*)::int AS n FROM auction_details')
    expect(details.rows[0].n).toBe(0)
    const translations = await pool.query('SELECT count(*)::int AS n FROM auction_translations')
    expect(translations.rows[0].n).toBe(0)
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
