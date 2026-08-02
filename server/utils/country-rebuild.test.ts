import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrawlResult } from '~/types/auction'

const state = vi.hoisted(() => ({
  enabled: true,
  pool: null as { query: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> } | null,
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

vi.mock('./db', () => ({ getPool: vi.fn(() => state.pool) }))
vi.mock('./list-cache', () => ({ writeListCache: state.writeListCache }))
vi.mock('./history', () => ({ recordObservations: state.recordObservations }))
vi.mock('./alert-matching', () => ({ matchAlerts: state.matchAlerts }))
vi.mock('./raw-archive', () => ({ archiveAuction: state.archiveAuction }))
vi.mock('./raw-archive-delete', () => ({ deleteRawArchiveCountry: state.deleteRawArchiveCountry }))
vi.mock('./current-auctions', () => ({ ensureAuctionIdentity: state.ensureAuctionIdentity }))
vi.mock('./auction-fetch-state', () => ({ writeAuctionCrawlFetchState: state.writeAuctionCrawlFetchState }))

function makePool() {
  const query = vi.fn(async (sql: string) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0 }
    if (sql.includes('DELETE FROM list_cache')) return { rowCount: 1 }
    if (sql.includes('DELETE FROM auction_observations')) return { rowCount: 2 }
    if (sql.includes('DELETE FROM auctions')) return { rowCount: 3 }
    if (sql.includes('DELETE FROM auction_details')) return { rowCount: 4 }
    if (sql.includes('DELETE FROM auction_fetch_state')) return { rowCount: 4 }
    if (sql.includes('DELETE FROM location_enrichment')) return { rowCount: 5 }
    if (sql.includes('DELETE FROM auction_translations')) return { rowCount: 6 }
    throw new Error(`unexpected query: ${sql}`)
  })
  return { query, connect: vi.fn(async () => ({ query, release: vi.fn() })) }
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
      fetchState: 4,
      locationEnrichment: 5,
      auctionTranslations: 6,
      artifactCaptures: 7,
      artifactVersions: 8,
      artifactVersionItems: 9,
      artifactBlobs: 10,
    })
    expect(result.crawled).toMatchObject({ ok: 1, failed: 0, auctions: 1 })
    expect(state.pool?.query).toHaveBeenCalledWith('DELETE FROM list_cache WHERE country = $1', ['se'])
    expect(state.pool?.query).toHaveBeenCalledWith('DELETE FROM auctions WHERE country = $1', ['se'])
    expect(state.pool?.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM location_enrichment'),
      ['se'],
    )
    expect(state.pool?.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM auction_translations'),
      ['se'],
    )
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
    expect(state.pool?.query).not.toHaveBeenCalled()
  })
})
