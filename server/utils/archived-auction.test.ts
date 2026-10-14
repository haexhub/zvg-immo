import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import { downloadBlob, listDistinctCaptures } from './storage-download'
import { hasDetailData, overlayDetailData, readArchivedAuctionSnapshot, SNAPSHOT_SCAN_LIMIT } from './archived-auction'

vi.mock('./storage-download', () => ({ downloadBlob: vi.fn(), listDistinctCaptures: vi.fn() }))

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'kip', country: 'de', region: 'Bremen', externalId: 'H1', caseNumber: '', authority: '',
    title: 'Freistehendes Einfamilienhaus', address: null, marketValueEur: null, marketValueText: null,
    auctionDateIso: null, auctionDateText: null, cancelled: false, sourceUpdatedIso: null,
    pdfUrl: null, detailUrl: null, pdfUrlUpstream: null, detailUrlUpstream: null,
    attachments: [], description: null, photoCount: 0, thumbnailUrl: null,
    ...overrides,
  } as Auction
}

function stubSnapshots(snapshots: Array<Auction | null>): void {
  vi.mocked(listDistinctCaptures).mockResolvedValue(
    snapshots.map((_, i) => ({ contentHash: `h${i}`, sourceUrl: null, capturedAt: `2026-10-1${5 - i}` })),
  )
  vi.mocked(downloadBlob).mockImplementation(async (hash: string) => {
    const snapshot = snapshots[Number(hash.slice(1))]
    return snapshot ? Buffer.from(JSON.stringify(snapshot)) : null
  })
}

beforeEach(() => {
  vi.mocked(downloadBlob).mockReset()
  vi.mocked(listDistinctCaptures).mockReset()
})

describe('hasDetailData', () => {
  it('is false for a listing-only snapshot', () => {
    expect(hasDetailData(auction())).toBe(false)
    expect(hasDetailData(auction({ description: '   ', detailFetchedAt: '2026-10-12T08:52:47Z' }))).toBe(false)
  })

  it('is true once a description, attachment or source value is present', () => {
    expect(hasDetailData(auction({ description: 'Haus' }))).toBe(true)
    expect(hasDetailData(auction({ attachments: [{ url: 'x', label: 'Gutachten' } as never] }))).toBe(true)
    expect(hasDetailData(auction({ sourceLivingAreaSqm: 109 }))).toBe(true)
    expect(hasDetailData(auction({ sourceRooms: 4 }))).toBe(true)
  })
})

describe('overlayDetailData', () => {
  it('keeps list-level values and fills the missing detail fields', () => {
    const merged = overlayDetailData(
      auction({ currentBid: 90_000, cancelled: true }),
      auction({ currentBid: 80_000, description: 'Baujahr 1936', sourceLandAreaSqm: 695, detailFetchedAt: '2026-10-12T08:52:47Z', marketValueText: '120.000 €' }),
    )
    expect(merged.currentBid).toBe(90_000)
    expect(merged.cancelled).toBe(true)
    expect(merged.description).toBe('Baujahr 1936')
    expect(merged.sourceLandAreaSqm).toBe(695)
    expect(merged.detailFetchedAt).toBe('2026-10-12T08:52:47Z')
    expect(merged.marketValueText).toBe('120.000 €')
  })

  it('does not overwrite detail values the base already has', () => {
    const merged = overlayDetailData(auction({ description: 'neu' }), auction({ description: 'alt', sourceRooms: 3 }))
    expect(merged.description).toBe('neu')
    expect(merged.sourceRooms).toBe(3)
  })
})

describe('readArchivedAuctionSnapshot', () => {
  it('returns null when nothing is archived', async () => {
    vi.mocked(listDistinctCaptures).mockResolvedValue([])
    expect(await readArchivedAuctionSnapshot('kip', 'H1')).toBeNull()
  })

  it('uses the newest snapshot unchanged when it already has detail data', async () => {
    stubSnapshots([auction({ description: 'Beschreibung' }), auction({ description: 'ältere' })])
    const result = await readArchivedAuctionSnapshot('kip', 'H1')
    expect(result?.description).toBe('Beschreibung')
    expect(downloadBlob).toHaveBeenCalledTimes(1)
  })

  it('fills the description from an older enriched snapshot when the newest is listing-only', async () => {
    stubSnapshots([auction({ currentBid: 95_000 }), auction({ description: 'Baujahr 1936, 109 m²' })])
    const result = await readArchivedAuctionSnapshot('kip', 'H1')
    expect(result?.description).toBe('Baujahr 1936, 109 m²')
    expect(result?.currentBid).toBe(95_000)
  })

  it('skips unreadable older blobs and keeps looking', async () => {
    stubSnapshots([auction(), null, auction({ description: 'gefunden' })])
    expect((await readArchivedAuctionSnapshot('kip', 'H1'))?.description).toBe('gefunden')
  })

  it('falls back to the newest snapshot when no older one has detail data', async () => {
    stubSnapshots([auction({ title: 'neu' }), auction({ title: 'alt' })])
    const result = await readArchivedAuctionSnapshot('kip', 'H1')
    expect(result?.title).toBe('neu')
    expect(result?.description).toBeNull()
  })

  it('returns null when the newest blob is missing or unparseable', async () => {
    stubSnapshots([null, auction({ description: 'x' })])
    expect(await readArchivedAuctionSnapshot('kip', 'H1')).toBeNull()
    vi.mocked(listDistinctCaptures).mockResolvedValue([{ contentHash: 'h0', sourceUrl: null, capturedAt: 'x' }])
    vi.mocked(downloadBlob).mockResolvedValue(Buffer.from('not json'))
    expect(await readArchivedAuctionSnapshot('kip', 'H1')).toBeNull()
  })

  it('asks the archive for a bounded number of distinct snapshots', async () => {
    vi.mocked(listDistinctCaptures).mockResolvedValue([])
    await readArchivedAuctionSnapshot('kip', 'H1')
    expect(listDistinctCaptures).toHaveBeenCalledWith('auction', 'kip', 'H1', SNAPSHOT_SCAN_LIMIT)
  })
})
