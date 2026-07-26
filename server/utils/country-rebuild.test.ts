import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrawlResult } from '~/types/auction'

const state = vi.hoisted(() => ({
  enabled: true,
  pool: null as { query: ReturnType<typeof vi.fn> } | null,
  crawlSingle: vi.fn(),
  writeListCache: vi.fn(),
  recordObservations: vi.fn(),
  matchAlerts: vi.fn(),
  archiveAuction: vi.fn(),
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

function makePool() {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('DELETE FROM list_cache')) return { rowCount: 1 }
    if (sql.includes('DELETE FROM auctions')) return { rowCount: 2 }
    if (sql.includes('DELETE FROM auction_snapshot')) return { rowCount: 3 }
    if (sql.includes('DELETE FROM extraction_cache')) return { rowCount: 4 }
    throw new Error(`unexpected query: ${sql}`)
  })
  return { query }
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
})

describe('rebuildCountry', () => {
  it('deletes current country data, crawls every region and rewrites the list cache', async () => {
    const { rebuildCountry } = await import('./country-rebuild')

    const result = await rebuildCountry('SE')

    expect(result.deleted).toEqual({
      listCache: 1,
      currentAuctions: 2,
      auctionSnapshot: 3,
      extractionCache: 4,
    })
    expect(result.crawled).toMatchObject({ ok: 1, failed: 0, auctions: 1 })
    expect(state.pool?.query).toHaveBeenCalledWith('DELETE FROM list_cache WHERE country = $1', ['se'])
    expect(state.pool?.query).toHaveBeenCalledWith('DELETE FROM auctions WHERE country = $1', ['se'])
    expect(state.pool?.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM auction_snapshot'),
      ['se', ['se-kronofogden']],
    )
    expect(state.pool?.query).toHaveBeenCalledWith(
      'DELETE FROM extraction_cache WHERE platform = ANY($1::text[])',
      [['se-kronofogden']],
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
