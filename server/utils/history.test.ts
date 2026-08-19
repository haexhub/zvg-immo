import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import { auctionToObservationRow, readLatestObservedAuction } from './history'

const query = vi.fn()
vi.mock('./db', () => ({ getPool: () => ({ query }) }))

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'test',
    country: 'de',
    region: 'Sachsen',
    externalId: '42',
    caseNumber: '1 K 1/26',
    authority: 'AG Test',
    title: 'Einfamilienhaus',
    address: null,
    marketValueEur: 250000,
    marketValueText: null,
    auctionDateIso: '2026-08-01T09:00:00.000Z',
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

describe('auctionToObservationRow', () => {
  it('maps the core auction fields to the observation row shape', () => {
    const row = auctionToObservationRow(auction(), '2026-07-17T00:00:00.000Z')
    expect(row).toEqual({
      captured_at: '2026-07-17T00:00:00.000Z',
      platform: 'test',
      country: 'de',
      region: 'Sachsen',
      external_id: '42',
      authority: 'AG Test',
      case_number: '1 K 1/26',
      title: 'Einfamilienhaus',
      property_type: null,
      land_area_sqm: null,
      living_area_sqm: null,
      rooms: null,
      units: null,
      market_value_eur: 250000,
      market_value: null,
      currency: null,
      auction_date_iso: '2026-08-01T09:00:00.000Z',
      cancelled: false,
      payload: auction(),
    })
  })

  it('carries marketValue/currency through when the crawler set them', () => {
    const row = auctionToObservationRow(
      auction({ marketValue: 6_500_000, currency: 'CZK' }),
      '2026-07-17T00:00:00.000Z',
    )
    expect(row.market_value).toBe(6_500_000)
    expect(row.currency).toBe('CZK')
  })

  it('pulls property type + sizes from extraction when present', () => {
    const withExtraction = auction({
      extraction: {
        propertyType: 'einfamilienhaus',
        landAreaSqm: 500,
        livingAreaSqm: 120,
        rooms: 4,
        units: 1,
        source: 'rules',
        confidence: 'high',
        at: '2026-07-17T00:00:00.000Z',
      },
    })
    const row = auctionToObservationRow(withExtraction, '2026-07-17T00:00:00.000Z')
    expect(row.property_type).toBe('einfamilienhaus')
    expect(row.land_area_sqm).toBe(500)
    expect(row.living_area_sqm).toBe(120)
    expect(row.rooms).toBe(4)
    expect(row.units).toBe(1)
  })

  it('leaves extracted fields null when no extraction is present', () => {
    const row = auctionToObservationRow(auction(), '2026-07-17T00:00:00.000Z')
    expect(row.property_type).toBeNull()
    expect(row.land_area_sqm).toBeNull()
    expect(row.living_area_sqm).toBeNull()
    expect(row.rooms).toBeNull()
    expect(row.units).toBeNull()
  })
})

describe('readLatestObservedAuction', () => {
  beforeEach(() => query.mockReset().mockResolvedValue({ rows: [] }))

  it('reads one indexed row instead of scanning every cached region blob', async () => {
    await readLatestObservedAuction('zvg-portal', '42')

    const [sql, values] = query.mock.calls[0]!
    expect(sql).toContain('WHERE platform = $1 AND external_id = $2')
    expect(sql).toContain('ORDER BY captured_at DESC')
    expect(sql).toContain('LIMIT 1')
    expect(values).toEqual(['zvg-portal', '42'])
  })

  it('returns the stored source record for the newest observation', async () => {
    const payload = auction({ externalId: '42' })
    query.mockResolvedValue({ rows: [{ payload }] })

    expect(await readLatestObservedAuction('zvg-portal', '42')).toEqual(payload)
  })

  it('returns null for an auction that was never observed', async () => {
    expect(await readLatestObservedAuction('zvg-portal', 'unknown')).toBeNull()
  })

  it('propagates a query failure instead of masking it as a miss', async () => {
    query.mockRejectedValueOnce(new Error('connection lost'))

    // The caller must be able to tell "database unavailable" apart from
    // "genuinely never observed" — collapsing both to null would make it fall
    // through to a live upstream crawl on every affected request.
    await expect(readLatestObservedAuction('zvg-portal', '42')).rejects.toThrow('connection lost')
  })
})
