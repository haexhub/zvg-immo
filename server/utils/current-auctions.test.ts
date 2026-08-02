import { describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import { getPool } from './db'

vi.mock('./db', () => ({ getPool: vi.fn() }))

const { auctionToCurrentRow, ensureAuctionIdentity, upsertCurrentAuctions } = await import('./current-auctions')

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

describe('auction identity persistence', () => {
  it('projects only identity and scheduling fields', () => {
    const row = auctionToCurrentRow(makeAuction({
      marketValueEur: 250000,
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
      updated_at: '2026-08-02T11:00:00.000Z',
    })
    expect(row).not.toHaveProperty('address')
    expect(row).not.toHaveProperty('property_type')
    expect(row).not.toHaveProperty('market_value_eur')
  })

  it('upserts deduplicated identities with last-wins values', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 })
    vi.mocked(getPool).mockReturnValue({ query } as never)

    await upsertCurrentAuctions([
      makeAuction({ title: 'old' }),
      makeAuction({ title: 'new', cancelled: true }),
    ], '2026-08-02T11:00:00.000Z')

    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]?.[0]).toContain('ON CONFLICT (platform, external_id) DO UPDATE SET')
    expect(query.mock.calls[0]?.[1]).toHaveLength(11)
    expect(query.mock.calls[0]?.[1]).toContain('new')
    expect(query.mock.calls[0]?.[1]).not.toContain('old')
  })

  it('creates prerequisite identities without updating existing rows', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 })
    vi.mocked(getPool).mockReturnValue({ query } as never)

    await ensureAuctionIdentity([makeAuction()])

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
