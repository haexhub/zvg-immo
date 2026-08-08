import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { Auction, AuctionExtraction } from '~/types/auction'
import { getDb, getPool } from './db'

vi.mock('./db', () => ({ getDb: vi.fn(), getPool: vi.fn() }))

const {
  auctionDetailsValues,
  deleteAuctionDetailsVersion,
  invalidateAuctionDetailsCache,
  promoteAuctionDetailsVersion,
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
    vi.mocked(getDb).mockReturnValue(drizzle(pool) as never)
    // readAuctionRecord/upsertCurrentAuctions (used by promoteAuctionDetailsVersion)
    // go through getPool()'s plain pg.Pool API, not getDb()'s drizzle wrapper.
    vi.mocked(getPool).mockReturnValue(pool)
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

  it('a trial write never becomes is_latest and readLatestAuctionDetails keeps serving the live version', async () => {
    const live = await writeAuctionDetails(makeAuction(), makeExtraction({ livingAreaSqm: 120 }))
    expect(live).toEqual({ version: 1, changed: true })

    const trial = await writeAuctionDetails(
      makeAuction(),
      makeExtraction({ livingAreaSqm: 999 }),
      { trial: true },
    )
    expect(trial).toEqual({ version: 2, changed: true })

    const latest = await readLatestAuctionDetails('zvg-portal', '7265')
    expect(Number(latest?.living_area_sqm)).toBe(120)

    const { rows } = await pool.query<{ version: number; is_latest: boolean; is_trial: boolean }>(
      `SELECT version, is_latest, is_trial FROM auction_details
       WHERE platform = 'zvg-portal' AND external_id = '7265' ORDER BY version`,
    )
    expect(rows).toEqual([
      { version: 1, is_latest: true, is_trial: false },
      { version: 2, is_latest: false, is_trial: true },
    ])
  })

  it('a trial write skips the unchanged-check even when it reproduces the live values exactly', async () => {
    // Reproducing the live facts with a different model IS the measurement —
    // deduping it away like a normal re-run would silently hide that result.
    await writeAuctionDetails(makeAuction(), makeExtraction())
    const trial = await writeAuctionDetails(makeAuction(), makeExtraction(), { trial: true })
    expect(trial).toEqual({ version: 2, changed: true })

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM auction_details')
    expect(rows[0].n).toBe(2)
  })

  it('a normal write after a trial compares against the live row, not the trial, for both demotion and the unchanged-check', async () => {
    // Before WP-0, "previous" was ORDER BY version DESC LIMIT 1 — once a
    // trial version exists it outranks the live row in version without ever
    // being it, so a cron run reproducing the live facts would wrongly diff
    // against the trial's (different) values and mint a needless version.
    await writeAuctionDetails(makeAuction(), makeExtraction({ livingAreaSqm: 120 })) // v1, live
    await writeAuctionDetails(makeAuction(), makeExtraction({ livingAreaSqm: 200 }), { trial: true }) // v2, trial

    const repeat = await writeAuctionDetails(makeAuction(), makeExtraction({ livingAreaSqm: 120 }))
    expect(repeat).toEqual({ version: 1, changed: false })

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM auction_details')
    expect(rows[0].n).toBe(2)

    const changed = await writeAuctionDetails(makeAuction(), makeExtraction({ livingAreaSqm: 140 })) // v3, live
    expect(changed).toEqual({ version: 3, changed: true })

    const flags = await pool.query<{ version: number; is_latest: boolean }>(
      `SELECT version, is_latest FROM auction_details
       WHERE platform = 'zvg-portal' AND external_id = '7265' ORDER BY version`,
    )
    expect(flags.rows).toEqual([
      { version: 1, is_latest: false },
      { version: 2, is_latest: false },
      { version: 3, is_latest: true },
    ])
  })

  it('stores llm provenance and run trigger passed via options', async () => {
    const write = await writeAuctionDetails(makeAuction(), makeExtraction(), {
      llmProvider: 'gemini-native',
      llmModel: 'gemini-flash-latest',
      llmProfileId: 'profile-a',
      runTrigger: 'manual',
      llmDurationMs: 4200,
    })
    expect(write).toEqual({ version: 1, changed: true })

    const { rows } = await pool.query<{
      llm_provider: string
      llm_model: string
      llm_profile_id: string
      run_trigger: string
      llm_duration_ms: number
    }>(
      `SELECT llm_provider, llm_model, llm_profile_id, run_trigger, llm_duration_ms
       FROM auction_details WHERE platform = 'zvg-portal' AND external_id = '7265'`,
    )
    expect(rows[0]).toEqual({
      llm_provider: 'gemini-native',
      llm_model: 'gemini-flash-latest',
      llm_profile_id: 'profile-a',
      run_trigger: 'manual',
      llm_duration_ms: 4200,
    })
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

  it('round-trips a non-empty features array', async () => {
    // features is the one text[] column in VALUE_COLUMNS — Drizzle's sql``
    // template expands a bound JS array into a parenthesized parameter list
    // (`($1, $2, $3)`, meant for IN (...) clauses) rather than a single array
    // parameter, so a naive per-column `${value}::${type}` cast breaks for
    // this column specifically once the LLM actually returns features.
    const write = await writeAuctionDetails(makeAuction(), makeExtraction({ features: ['garten', 'garage'] }))
    expect(write).toEqual({ version: 1, changed: true })

    const latest = await readLatestAuctionDetails('zvg-portal', '7265')
    expect(latest?.features).toEqual(['garten', 'garage'])
  })

  it('round-trips an empty features array', async () => {
    const write = await writeAuctionDetails(makeAuction(), makeExtraction({ features: [] }))
    expect(write).toEqual({ version: 1, changed: true })

    const latest = await readLatestAuctionDetails('zvg-portal', '7265')
    expect(latest?.features).toEqual([])
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

  describe('promoteAuctionDetailsVersion / deleteAuctionDetailsVersion (WP-5)', () => {
    it('promotes a trial version to live, demoting the previous live row', async () => {
      await writeAuctionDetails(makeAuction(), makeExtraction({ livingAreaSqm: 120 }))
      await writeAuctionDetails(makeAuction(), makeExtraction({ livingAreaSqm: 150 }), { trial: true })

      await expect(promoteAuctionDetailsVersion('zvg-portal', '7265', 2)).resolves.toBe('promoted')

      const { rows } = await pool.query<{ version: number; is_latest: boolean; is_trial: boolean }>(
        `SELECT version, is_latest, is_trial FROM auction_details
         WHERE platform = 'zvg-portal' AND external_id = '7265' ORDER BY version`,
      )
      expect(rows).toEqual([
        { version: 1, is_latest: false, is_trial: false },
        { version: 2, is_latest: true, is_trial: false },
      ])
      const latest = await readLatestAuctionDetails('zvg-portal', '7265')
      expect(Number(latest?.living_area_sqm)).toBe(150)
    })

    it('is idempotent when promoting the version that is already live', async () => {
      await writeAuctionDetails(makeAuction(), makeExtraction())

      await expect(promoteAuctionDetailsVersion('zvg-portal', '7265', 1)).resolves.toBe('promoted')

      const { rows } = await pool.query<{ is_latest: boolean; is_trial: boolean }>(
        `SELECT is_latest, is_trial FROM auction_details WHERE platform = 'zvg-portal' AND external_id = '7265' AND version = 1`,
      )
      expect(rows[0]).toEqual({ is_latest: true, is_trial: false })
    })

    it('promote returns not_found for a version that does not exist', async () => {
      await writeAuctionDetails(makeAuction(), makeExtraction())

      await expect(promoteAuctionDetailsVersion('zvg-portal', '7265', 99)).resolves.toBe('not_found')
    })

    it('refuses to delete the live version', async () => {
      await writeAuctionDetails(makeAuction(), makeExtraction())

      await expect(deleteAuctionDetailsVersion('zvg-portal', '7265', 1)).resolves.toBe('is_latest')
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM auction_details')
      expect(rows[0].n).toBe(1)
    })

    it('deletes a non-live version and cascades its photos', async () => {
      await writeAuctionDetails(makeAuction(), makeExtraction())
      await writeAuctionDetails(
        makeAuction(),
        makeExtraction({
          livingAreaSqm: 200,
          photos: [{ file: 'front.jpg', category: 'aussen', caption: null, isPropertyPhoto: true }],
        }),
        { trial: true },
      )

      await expect(deleteAuctionDetailsVersion('zvg-portal', '7265', 2)).resolves.toBe('deleted')

      const details = await pool.query<{ version: number }>('SELECT version FROM auction_details')
      expect(details.rows.map((r) => r.version)).toEqual([1])
      const photos = await pool.query('SELECT count(*)::int AS n FROM auction_photos')
      expect(photos.rows[0].n).toBe(0)
    })

    it('delete returns not_found for a version that does not exist', async () => {
      await writeAuctionDetails(makeAuction(), makeExtraction())

      await expect(deleteAuctionDetailsVersion('zvg-portal', '7265', 99)).resolves.toBe('not_found')
    })
  })
})
