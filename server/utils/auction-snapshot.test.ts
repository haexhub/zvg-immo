import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import { applySnapshotPhotosToAuctions, mergePreservedDetail, normalizeLegacyAuction } from './auction-snapshot'
import type { AuctionSnapshot } from './auction-snapshot'

vi.mock('./db', () => ({ getPool: vi.fn() }))

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'test',
    country: 'de',
    region: 'all',
    externalId: '42',
    caseNumber: '1 K 1/26',
    authority: '',
    title: 'Einfamilienhaus',
    address: null,
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
    ...overrides,
  }
}

describe('mergePreservedDetail — structured source fields', () => {
  it('preserves source areas and rooms when the fresh crawl lacks them', () => {
    const next = mergePreservedDetail(
      auction(),
      auction({ sourceLivingAreaSqm: 120, sourceLandAreaSqm: 500, sourceRooms: 4 }),
    )
    expect(next.sourceLivingAreaSqm).toBe(120)
    expect(next.sourceLandAreaSqm).toBe(500)
    expect(next.sourceRooms).toBe(4)
  })

  it('keeps fresh source values over the previous ones', () => {
    const next = mergePreservedDetail(
      auction({ sourceLivingAreaSqm: 99, sourceRooms: 3 }),
      auction({ sourceLivingAreaSqm: 120, sourceRooms: 4 }),
    )
    expect(next.sourceLivingAreaSqm).toBe(99)
    expect(next.sourceRooms).toBe(3)
  })

  it('preserves startingBid and sourceSecurityDeposit when the fresh crawl lacks them', () => {
    const next = mergePreservedDetail(
      auction(),
      auction({ startingBid: 50_000, sourceSecurityDeposit: 5_000 }),
    )
    expect(next.startingBid).toBe(50_000)
    expect(next.sourceSecurityDeposit).toBe(5_000)
  })

  it('does not preserve currentBid — it is live auction state, not a static fact', () => {
    const next = mergePreservedDetail(auction(), auction({ currentBid: 60_000 }))
    expect(next.currentBid).toBeUndefined()
  })
})

describe('mergePreservedDetail — photoUrls and photoCount', () => {
  it('restores the gallery and keeps photoCount consistent with it', () => {
    const next = mergePreservedDetail(
      auction({ photoCount: 1, thumbnailUrl: 'https://x/1.jpg' }),
      auction({ photoCount: 5, photoUrls: ['a', 'b', 'c', 'd', 'e'] }),
    )
    expect(next.photoUrls).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(next.photoCount).toBe(5)
  })

  it('does not lower a higher fresh photoCount when restoring photoUrls', () => {
    const next = mergePreservedDetail(
      auction({ photoCount: 7 }),
      auction({ photoUrls: ['a', 'b'] }),
    )
    expect(next.photoUrls).toEqual(['a', 'b'])
    expect(next.photoCount).toBe(7)
  })

  it('keeps a fresh non-empty gallery', () => {
    const next = mergePreservedDetail(
      auction({ photoUrls: ['new'], photoCount: 1 }),
      auction({ photoUrls: ['old1', 'old2'], photoCount: 2 }),
    )
    expect(next.photoUrls).toEqual(['new'])
    expect(next.photoCount).toBe(1)
  })
})

describe('mergePreservedDetail — coordinates', () => {
  it('restores lat/lng as a pair', () => {
    const next = mergePreservedDetail(auction(), auction({ lat: 48.9, lng: 8.5 }))
    expect(next.lat).toBe(48.9)
    expect(next.lng).toBe(8.5)
  })

  it('does not restore a previous half-pair', () => {
    const next = mergePreservedDetail(auction(), auction({ lat: 48.9, lng: null }))
    expect(next.lat).toBeUndefined()
  })

  it('keeps fresh coordinates', () => {
    const next = mergePreservedDetail(
      auction({ lat: 1, lng: 2 }),
      auction({ lat: 48.9, lng: 8.5 }),
    )
    expect(next.lat).toBe(1)
    expect(next.lng).toBe(2)
  })
})

describe('mergePreservedDetail — value bundle', () => {
  it('restores the whole value bundle when a re-crawl lost it (detail-page value)', () => {
    const next = mergePreservedDetail(
      auction(),
      auction({
        marketValueEur: 70512,
        marketValue: 1_762_800,
        currency: 'CZK',
        marketValueText: '1.762.800 Kč',
      }),
    )
    expect(next.marketValueEur).toBe(70512)
    expect(next.marketValue).toBe(1_762_800)
    expect(next.currency).toBe('CZK')
    expect(next.marketValueText).toBe('1.762.800 Kč')
  })

  it('keeps a fresh native value that only lacks a EUR conversion (missing rate)', () => {
    const next = mergePreservedDetail(
      auction({ marketValue: 500, currency: 'XYZ', marketValueText: '500 XYZ' }),
      auction({ marketValueEur: 70512, marketValue: 1_762_800, currency: 'CZK' }),
    )
    expect(next.marketValue).toBe(500)
    expect(next.currency).toBe('XYZ')
    expect(next.marketValueEur).toBeNull()
  })

  it('restores a native value bundle even if the previous snapshot lacked a EUR conversion', () => {
    const next = mergePreservedDetail(
      auction({ marketValueEur: null, marketValue: null }),
      auction({ marketValueEur: null, marketValue: 500, currency: 'XYZ', marketValueText: '500 XYZ' }),
    )
    expect(next.marketValue).toBe(500)
    expect(next.currency).toBe('XYZ')
    expect(next.marketValueText).toBe('500 XYZ')
    expect(next.marketValueEur).toBeNull()
  })
})

describe('mergePreservedDetail — caseNumber', () => {
  it('restores a previously known caseNumber when the re-crawl lost it', () => {
    expect(mergePreservedDetail(auction({ caseNumber: '' }), auction()).caseNumber).toBe(
      '1 K 1/26',
    )
  })

  it('keeps a fresh caseNumber', () => {
    const next = mergePreservedDetail(auction({ caseNumber: '2 K 9/26' }), auction())
    expect(next.caseNumber).toBe('2 K 9/26')
  })
})

describe('mergePreservedDetail — description', () => {
  it('restores the description when the fresh crawl has none', () => {
    const next = mergePreservedDetail(auction(), auction({ description: 'Alt' }))
    expect(next.description).toBe('Alt')
  })

  it('keeps the enriched extension when it starts with the fresh list text', () => {
    const next = mergePreservedDetail(
      auction({ description: 'Listentext.' }),
      auction({
        description: 'Listentext.\nKadastra apzīmējums: 0100 012 0345',
        detailFetchedAt: '2026-07-01T00:00:00.000Z',
      }),
    )
    expect(next.description).toBe('Listentext.\nKadastra apzīmējums: 0100 012 0345')
  })

  it('does not restore an extension the detail fetch never produced', () => {
    // prev longer but never detail-fetched → could be stale list text; keep next.
    const next = mergePreservedDetail(
      auction({ description: 'Listentext.' }),
      auction({ description: 'Listentext.\nMehr' }),
    )
    expect(next.description).toBe('Listentext.')
  })

  it('keeps a genuinely changed fresh description', () => {
    const next = mergePreservedDetail(
      auction({ description: 'Neuer Text' }),
      auction({
        description: 'Alter Text mit Anhang',
        detailFetchedAt: '2026-07-01T00:00:00.000Z',
      }),
    )
    expect(next.description).toBe('Neuer Text')
  })
})

describe('normalizeLegacyAuction — pre-WP-1 snapshot field names', () => {
  it('maps every renamed field to its new name and drops the old key', () => {
    const legacy: Record<string, unknown> = {
      platform: 'zvg-portal',
      zvgId: '99',
      aktenzeichen: '1 K 5/25',
      amtsgericht: 'AG Musterstadt',
      objekt: 'Reihenhaus',
      adresse: 'Musterweg 1',
      verkehrswertEur: 250000,
      verkehrswertText: '250.000 €',
      terminIso: '2026-08-01T09:00:00.000Z',
      terminText: '01.08.2026 09:00',
      aufgehoben: false,
      letzteAktualisierungIso: '2026-07-01T00:00:00.000Z',
      beschreibung: 'Alte Beschreibung',
      fotoCount: 3,
      detailFetchedAt: '2026-07-01T00:00:00.000Z',
    }
    normalizeLegacyAuction(legacy)

    expect(legacy.externalId).toBe('99')
    expect(legacy.caseNumber).toBe('1 K 5/25')
    expect(legacy.authority).toBe('AG Musterstadt')
    expect(legacy.title).toBe('Reihenhaus')
    expect(legacy.address).toBe('Musterweg 1')
    expect(legacy.marketValueEur).toBe(250000)
    expect(legacy.marketValueText).toBe('250.000 €')
    expect(legacy.auctionDateIso).toBe('2026-08-01T09:00:00.000Z')
    expect(legacy.auctionDateText).toBe('01.08.2026 09:00')
    expect(legacy.cancelled).toBe(false)
    expect(legacy.sourceUpdatedIso).toBe('2026-07-01T00:00:00.000Z')
    expect(legacy.description).toBe('Alte Beschreibung')
    expect(legacy.photoCount).toBe(3)
    // detailFetchedAt is preserved (unchanged name), which is exactly why the
    // renamed fields must be mapped: it suppresses re-enrichment.
    expect(legacy.detailFetchedAt).toBe('2026-07-01T00:00:00.000Z')

    for (const oldKey of [
      'zvgId', 'aktenzeichen', 'amtsgericht', 'objekt', 'adresse',
      'verkehrswertEur', 'verkehrswertText', 'terminIso', 'terminText',
      'aufgehoben', 'letzteAktualisierungIso', 'beschreibung', 'fotoCount',
    ]) {
      expect(legacy[oldKey]).toBeUndefined()
    }
  })

  it('leaves an already-migrated entry untouched (no-op after re-crawl)', () => {
    const current: Record<string, unknown> = { externalId: '7', description: 'Neu', photoCount: 2 }
    normalizeLegacyAuction(current)
    expect(current).toEqual({ externalId: '7', description: 'Neu', photoCount: 2 })
  })

  it('does not clobber a present new value with a stale legacy one', () => {
    const mixed: Record<string, unknown> = { description: 'Neu', beschreibung: 'Alt' }
    normalizeLegacyAuction(mixed)
    expect(mixed.description).toBe('Neu')
  })
})

// readAuctionSnapshot()/writeAuctionSnapshot() are backed by Postgres
// (`auction_snapshot` table, WP-5) with an in-process memoized cache, same
// pattern as extraction-cache.ts. Each test re-imports the module fresh to
// isolate that module-scope state.
describe('readAuctionSnapshot / writeAuctionSnapshot (Postgres-backed)', () => {
  afterEach(() => {
    vi.resetModules()
  })

  function makeFakePool(rows: Array<{ platform: string; external_id: string; auction: Auction }> = []) {
    const upserted: Array<{ platform: string; external_id: string; auction: Auction }> = []
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT platform, external_id, auction FROM auction_snapshot')) {
        return { rows, rowCount: rows.length }
      }
      if (sql.includes('INSERT INTO auction_snapshot')) {
        for (let i = 0; i < params.length; i += 3) {
          upserted.push({
            platform: params[i] as string,
            external_id: params[i + 1] as string,
            auction: JSON.parse(params[i + 2] as string),
          })
        }
        return { rows: [], rowCount: params.length / 3 }
      }
      throw new Error(`unexpected query: ${sql}`)
    })
    return { query, upserted }
  }

  it('returns an empty snapshot when Postgres is not configured', async () => {
    const { getPool } = await import('./db')
    vi.mocked(getPool).mockReturnValue(null)
    const { readAuctionSnapshot } = await import('./auction-snapshot')

    await expect(readAuctionSnapshot()).resolves.toEqual({})
  })

  it('loads every row from Postgres on first call', async () => {
    const { getPool } = await import('./db')
    const stored = auction({ description: 'Vom Vorlauf' })
    const pool = makeFakePool([{ platform: 'zvg-portal', external_id: '7265', auction: stored }])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { readAuctionSnapshot } = await import('./auction-snapshot')

    const snapshot = await readAuctionSnapshot()
    expect(snapshot['zvg-portal:7265']).toEqual(stored)
  })

  it('serves subsequent calls from memory without re-querying Postgres', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool([{ platform: 'zvg-portal', external_id: '7265', auction: auction() }])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { readAuctionSnapshot } = await import('./auction-snapshot')

    await readAuctionSnapshot()
    await readAuctionSnapshot()

    expect(pool.query).toHaveBeenCalledTimes(1)
  })

  it('is a no-op towards Postgres without a configured pool, but still updates the in-process cache', async () => {
    const { getPool } = await import('./db')
    vi.mocked(getPool).mockReturnValue(null)
    const { readAuctionSnapshot, writeAuctionSnapshot } = await import('./auction-snapshot')

    const fresh = auction({ description: 'Frisch' })
    await writeAuctionSnapshot([fresh])

    const snapshot = await readAuctionSnapshot()
    expect(snapshot['test:42']).toEqual(fresh)
  })

  it('merges the fresh auction with the previous snapshot entry (mergePreservedDetail)', async () => {
    const { getPool } = await import('./db')
    const prev = auction({ attachments: [{ kind: 'photo', label: 'Foto', filename: 'f.jpg', sizeBytes: null, fileId: '1', proxyUrl: '/x' }] })
    const pool = makeFakePool([{ platform: 'test', external_id: '42', auction: prev }])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { writeAuctionSnapshot } = await import('./auction-snapshot')

    const fresh = auction() // no attachments on the fresh crawl
    await writeAuctionSnapshot([fresh])

    expect(pool.upserted[0]?.auction.attachments).toEqual(prev.attachments)
  })

  it('never throws when the upsert query fails', async () => {
    const { getPool } = await import('./db')
    vi.mocked(getPool).mockReturnValue({ query: vi.fn().mockRejectedValue(new Error('connection reset')) } as never)
    const { writeAuctionSnapshot } = await import('./auction-snapshot')

    await expect(writeAuctionSnapshot([auction()])).resolves.toBeUndefined()
  })

  it('leaves an untouched platform\'s previous entry in place (row-level upsert, no carry-forward needed)', async () => {
    const { getPool } = await import('./db')
    const otherPlatform = auction({ platform: 'other', externalId: '99' })
    const pool = makeFakePool([{ platform: 'other', external_id: '99', auction: otherPlatform }])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { readAuctionSnapshot, writeAuctionSnapshot } = await import('./auction-snapshot')

    await writeAuctionSnapshot([auction()]) // only platform 'test' crawled this run

    const snapshot = await readAuctionSnapshot()
    expect(snapshot['other:99']).toEqual(otherPlatform)
    expect(snapshot['test:42']).toBeDefined()
  })
})

describe('applySnapshotPhotosToAuctions', () => {
  function snapshotOf(a: Auction): AuctionSnapshot {
    return { [`${a.platform}:${a.externalId}`]: a }
  }

  it('fills thumbnailUrl/photoCount from the snapshot when the list crawl has none', () => {
    const listAuction = auction() // list crawl: photoCount 0, thumbnailUrl null
    const snapshot = snapshotOf(
      auction({ thumbnailUrl: '/api/zvg-thumb?file_id=1&zvg_id=42&land_abk=by', photoCount: 2 }),
    )
    applySnapshotPhotosToAuctions([listAuction], snapshot)
    expect(listAuction.thumbnailUrl).toBe('/api/zvg-thumb?file_id=1&zvg_id=42&land_abk=by')
    expect(listAuction.photoCount).toBe(2)
  })

  it('fills photoUrls from the snapshot when the list crawl has none', () => {
    const listAuction = auction()
    const snapshot = snapshotOf(auction({ photoUrls: ['/api/auction-image/test/42/1.jpg'], photoCount: 1 }))
    applySnapshotPhotosToAuctions([listAuction], snapshot)
    expect(listAuction.photoUrls).toEqual(['/api/auction-image/test/42/1.jpg'])
  })

  it('does not overwrite a native photo already present on the list crawl', () => {
    const listAuction = auction({ thumbnailUrl: '/api/auction-image/test/42/native.jpg', photoCount: 1 })
    const snapshot = snapshotOf(auction({ thumbnailUrl: '/api/zvg-thumb?file_id=9', photoCount: 5 }))
    applySnapshotPhotosToAuctions([listAuction], snapshot)
    expect(listAuction.thumbnailUrl).toBe('/api/auction-image/test/42/native.jpg')
    expect(listAuction.photoCount).toBe(1)
  })

  it('leaves the auction untouched when no snapshot entry exists', () => {
    const listAuction = auction()
    applySnapshotPhotosToAuctions([listAuction], {})
    expect(listAuction.thumbnailUrl).toBeNull()
    expect(listAuction.photoCount).toBe(0)
  })
})
