import { beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { CrawlResult } from '~/types/auction'

const state = vi.hoisted(() => ({
  enabled: true,
  db: null as unknown,
  pool: null as {
    pool: object
    poolQuery: ReturnType<typeof vi.fn>
    clientQuery: ReturnType<typeof vi.fn>
  } | null,
  crawlSingle: vi.fn(),
  writeListCache: vi.fn(),
  recordObservations: vi.fn(),
  matchAlerts: vi.fn(),
  archiveAuction: vi.fn(),
  deleteRawArchiveCountry: vi.fn(),
  ensureAuctionIdentity: vi.fn(),
  writeAuctionCrawlFetchState: vi.fn(),
}))

vi.mock('../crawlers/registry', () => ({
  ensureEnabledCountriesLoaded: vi.fn(async () => ['se']),
  isCountryEnabled: vi.fn(() => state.enabled),
  listRegisteredCountries: vi.fn(() => [
    {
      code: 'se',
      name: 'Schweden',
      regions: [
        {
          code: 'all',
          name: 'Schweden',
          country: 'se',
          platforms: [{ id: 'se-kronofogden', name: 'Kronofogden' }],
        },
      ],
    },
  ]),
  crawlSingle: state.crawlSingle,
}))

vi.mock('./db', () => ({ getDb: vi.fn(() => state.db) }))
vi.mock('./list-cache', () => ({ writeListCache: state.writeListCache }))
vi.mock('./history', () => ({ recordObservations: state.recordObservations }))
vi.mock('./alert-matching', () => ({ matchAlerts: state.matchAlerts }))
vi.mock('./raw-archive', () => ({ archiveAuction: state.archiveAuction }))
vi.mock('./raw-archive-delete', () => ({
  deleteRawArchiveCountry: state.deleteRawArchiveCountry,
}))
vi.mock('./current-auctions', () => ({ ensureAuctionIdentity: state.ensureAuctionIdentity }))
vi.mock('./auction-fetch-state', () => ({ writeAuctionCrawlFetchState: state.writeAuctionCrawlFetchState }))

// rowCount per table, keyed by a substring of the compiled `delete from
// "<table>"` text Drizzle generates — lets each DELETE report a distinct,
// recognizable count without hand-writing the exact SQL Drizzle produces.
const ROW_COUNTS: Record<string, number> = {
  '"list_cache"': 1,
  '"auction_observations"': 2,
  '"auctions"': 3,
  '"auction_details"': 4,
  '"location_enrichment"': 5,
  '"auction_translations"': 6,
  '"auction_fetch_state"': 7,
}

function makePool() {
  const clientQuery = vi.fn(async (query: unknown) => {
    const text = typeof query === 'string' ? query : (query as { text: string }).text
    if (text === 'begin' || text === 'commit' || text === 'rollback') return { rowCount: 0 }
    const match = Object.keys(ROW_COUNTS).find((table) => text.startsWith(`delete from ${table}`))
    if (match) return { rowCount: ROW_COUNTS[match] }
    throw new Error(`unexpected query: ${text}`)
  })
  const poolQuery = vi.fn(async (sql: string) => {
    throw new Error(`unexpected pool query: ${sql}`)
  })
  // drizzle's transaction() only checks out its own connection (and releases
  // it afterwards) when the client it was constructed with looks like a
  // `pg.Pool` — it tests `instanceof Pool` or a constructor name containing
  // "Pool", so the mock needs a named constructor to take that branch.
  function MockPool() {}
  const pool = Object.assign(new (MockPool as unknown as new () => object)(), {
    query: poolQuery,
    connect: vi.fn(async () => ({ query: clientQuery, release: vi.fn() })),
  })
  return { pool, poolQuery, clientQuery }
}

const seResult: CrawlResult = {
  platform: 'se-kronofogden',
  source: 'https://auktionstorget.kronofogden.se',
  countries: ['se'],
  regions: ['Schweden'],
  fetchedAt: '2026-07-26T09:00:00.000Z',
  totalReported: 1,
  auctions: [
    {
      platform: 'se-kronofogden',
      country: 'se',
      region: 'all',
      externalId: '101784',
      caseNumber: 'F-2626-25',
      authority: 'Kronofogden',
      title: 'Småhusenhet',
      address: 'Kvarnbyn 76',
      marketValueEur: null,
      marketValueText: null,
      auctionDateIso: '2026-08-27',
      auctionDateText: '2026-08-27',
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
    },
  ],
}

beforeEach(() => {
  state.enabled = true
  state.pool = makePool()
  state.db = drizzle(state.pool.pool as never)
  state.crawlSingle.mockReset().mockResolvedValue(seResult)
  state.writeListCache.mockReset().mockResolvedValue(undefined)
  state.recordObservations.mockReset().mockResolvedValue(undefined)
  state.matchAlerts.mockReset().mockResolvedValue(undefined)
  state.archiveAuction.mockReset().mockResolvedValue(null)
  state.deleteRawArchiveCountry.mockReset().mockResolvedValue({
    country: 'se',
    deleted: { captures: 7, documentSets: 8, documentSetItems: 9, blobs: 10, localFiles: 0, storageFiles: 0 },
    failed: { localFiles: 0, storageFiles: 0 },
  })
})

describe('rebuildCountry', () => {
  it('deletes current country data, crawls every region and rewrites the list cache', async () => {
    const { rebuildCountry } = await import('./country-rebuild')

    const result = await rebuildCountry('SE')

    expect(result.deleted).toEqual({
      listCache: 1,
      observations: 2,
      auctions: 3,
      auctionDetails: 4,
      fetchState: 7,
      locationEnrichment: 5,
      auctionTranslations: 6,
      artifactCaptures: 7,
      artifactVersions: 8,
      artifactVersionItems: 9,
      artifactBlobs: 10,
    })
    expect(result.crawled).toMatchObject({ ok: 1, failed: 0, auctions: 1 })
    const clientQuery = state.pool!.clientQuery
    expect(state.pool!.poolQuery).not.toHaveBeenCalled()
    const queryText = (call: unknown[]) => {
      const arg = call[0]
      return typeof arg === 'string' ? arg : (arg as { text: string }).text
    }
    const sqlCalls = clientQuery.mock.calls.map(queryText)
    expect(sqlCalls[0]).toBe('begin')
    expect(sqlCalls.at(-1)).toBe('commit')
    expect(sqlCalls.some((text) => text.startsWith('delete from "location_enrichment"'))).toBe(true)
    expect(sqlCalls.some((text) => text.startsWith('delete from "auction_translations"'))).toBe(true)
    expect(state.crawlSingle).toHaveBeenCalledWith({
      country: 'se',
      region: 'all',
      immobilienOnly: true,
      enrichDetails: false,
    })
    expect(state.writeListCache).toHaveBeenCalledWith('se', 'all', seResult)
    expect(state.recordObservations).toHaveBeenCalledWith(seResult, expect.any(String))
    expect(state.matchAlerts).toHaveBeenCalledWith('se', 'all', seResult)
    expect(state.archiveAuction).toHaveBeenCalledWith(seResult.auctions[0], expect.any(String))
  })

  it('rejects disabled countries before deleting data', async () => {
    state.enabled = false
    const { rebuildCountry } = await import('./country-rebuild')

    await expect(rebuildCountry('se')).rejects.toMatchObject({ statusCode: 400 })
    expect(state.pool!.poolQuery).not.toHaveBeenCalled()
    expect(state.pool!.clientQuery).not.toHaveBeenCalled()
  })
})
