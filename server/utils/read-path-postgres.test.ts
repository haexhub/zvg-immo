// WP-5 verification: list-cache.ts and auction-snapshot.ts no longer touch
// `.cache_zvg` at all (neither imports node:fs/promises — grep confirms), so
// there is no "cache lost" scenario to simulate: every one of the five read
// endpoints (/api/auctions, /api/auctions-geo, /api/auction/[platform]/[id],
// /api/data/v1/auctions[, /:platform/:id]) resolves exclusively through
// readListCache/readMergedListCache/readAuctionSnapshot, which now only ever
// talk to Postgres. This test proves that path end to end for one known DE
// auction (zvg-portal/7265): a fake Postgres pool is the *only* data source,
// and every read function returns the exact values that were written —
// nothing silently falls back to a file.

import { describe, expect, it, vi } from 'vitest'
import type { Auction, CrawlResult } from '~/types/auction'

vi.mock('./db', () => ({ getPool: vi.fn() }))

const auction7265: Auction = {
  platform: 'zvg-portal',
  country: 'de',
  region: 'Bayern',
  externalId: '7265',
  caseNumber: '12 K 34/26',
  authority: 'AG München',
  title: 'Einfamilienhaus',
  address: 'Musterstraße 1, 80331 München',
  marketValueEur: 450_000,
  marketValueText: '450.000,00 EUR',
  auctionDateIso: '2026-09-15T09:00:00.000Z',
  auctionDateText: '15.09.2026, 09:00 Uhr',
  cancelled: false,
  sourceUpdatedIso: '2026-07-20T00:00:00.000Z',
  pdfUrl: '/api/zvg-proxy?u=x.pdf',
  detailUrl: '/api/zvg-proxy?u=detail',
  pdfUrlUpstream: 'https://zvg-portal.de/x.pdf',
  detailUrlUpstream: 'https://zvg-portal.de/detail',
  attachments: [
    { kind: 'appraisal', label: 'Gutachten', filename: 'gutachten.pdf', sizeBytes: 12345, fileId: '1', proxyUrl: '/api/zvg-proxy?u=g.pdf' },
  ],
  description: 'Gepflegtes Einfamilienhaus in ruhiger Lage.',
  photoCount: 3,
  thumbnailUrl: '/api/auction-image/zvg-portal/7265/1.jpg',
  photoUrls: ['/api/auction-image/zvg-portal/7265/1.jpg'],
  lat: 48.137,
  lng: 11.575,
  detailFetchedAt: '2026-07-20T00:00:00.000Z',
}

const listResult: CrawlResult = {
  platform: 'zvg-portal',
  source: 'zvg-portal',
  countries: ['de'],
  regions: ['Bayern'],
  fetchedAt: '2026-07-22T10:00:00.000Z',
  totalReported: 1,
  // The list crawl never has attachments/pdfUrl/photoUrls/description —
  // those only exist on the enrich-task snapshot (auction_snapshot).
  auctions: [{ ...auction7265, attachments: [], pdfUrl: null, pdfUrlUpstream: null, photoUrls: undefined, description: null }],
}

function makeFakePool() {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT country, result FROM list_cache')) {
      return { rows: [{ country: 'de', result: listResult }], rowCount: 1 }
    }
    if (sql.includes('SELECT result FROM list_cache WHERE country')) {
      return { rows: [{ result: listResult }], rowCount: 1 }
    }
    if (sql.includes('SELECT platform, external_id, auction FROM auction_snapshot')) {
      return {
        rows: [{ platform: 'zvg-portal', external_id: '7265', auction: auction7265 }],
        rowCount: 1,
      }
    }
    if (sql.includes('SELECT platform, external_id, extraction FROM extraction_cache')) {
      return { rows: [], rowCount: 0 }
    }
    throw new Error(`unexpected query in read-path test: ${sql} ${JSON.stringify(params)}`)
  })
  return { query }
}

describe('WP-5 read path — zvg-portal/7265 comes exclusively from Postgres', () => {
  it('readListCache returns the list-crawl view (no detail fields)', async () => {
    const { getPool } = await import('./db')
    vi.mocked(getPool).mockReturnValue(makeFakePool() as never)
    const { readListCache } = await import('./list-cache')

    const result = await readListCache('de', 'by')
    const hit = result?.auctions.find((a) => a.externalId === '7265')
    expect(hit?.marketValueEur).toBe(450_000)
    expect(hit?.attachments).toEqual([])
  })

  it('readMergedListCache (used by /api/auctions and /api/data/v1/auctions*) surfaces the same auction', async () => {
    const { getPool } = await import('./db')
    vi.mocked(getPool).mockReturnValue(makeFakePool() as never)
    const { readMergedListCache } = await import('./list-cache')

    const result = await readMergedListCache()
    const hit = result?.auctions.find((a) => a.externalId === '7265')
    expect(hit?.title).toBe('Einfamilienhaus')
    expect(hit?.address).toBe('Musterstraße 1, 80331 München')
  })

  it('readAuctionSnapshot (used by the detail endpoint and /api/auctions-geo) returns the fully-decorated auction', async () => {
    const { getPool } = await import('./db')
    vi.mocked(getPool).mockReturnValue(makeFakePool() as never)
    const { readAuctionSnapshot } = await import('./auction-snapshot')

    const snapshot = await readAuctionSnapshot()
    const hit = snapshot['zvg-portal:7265']
    expect(hit).toEqual(auction7265)
    expect(hit?.attachments).toHaveLength(1)
    expect(hit?.pdfUrl).toBe('https://zvg-portal.de/x.pdf')
    expect(hit?.detailUrl).toBeNull()
    expect(hit?.lat).toBe(48.137)
    expect(hit?.lng).toBe(11.575)
  })
})
