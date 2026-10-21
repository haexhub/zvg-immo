import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import { auctionToObservationRow, observationPayloadHash, readLatestObservedAuction, recordObservations } from './history'

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

describe('observationPayloadHash', () => {
  it('ignores per-run bookkeeping but not content', () => {
    const base = auction({
      extraction: {
        propertyType: 'einfamilienhaus',
        landAreaSqm: 500,
        livingAreaSqm: 120,
        rooms: 4,
        units: 1,
        source: 'llm',
        confidence: 'high',
        at: '2026-07-17T00:00:00.000Z',
        llmAnalyzedAt: '2026-07-17T00:00:00.000Z',
      },
    })
    const rerun = auction({
      detailFetchedAt: '2026-07-18T00:00:00.000Z',
      extraction: { ...base.extraction!, at: '2026-07-18T00:00:00.000Z', llmAnalyzedAt: '2026-07-18T00:00:00.000Z' },
    })

    expect(observationPayloadHash(rerun)).toBe(observationPayloadHash(base))
    expect(observationPayloadHash(auction({ ...base, extraction: { ...base.extraction!, rooms: 5 } })))
      .not.toBe(observationPayloadHash(base))
  })

  it('drops the EUR value only when it is derived from a native price', () => {
    // Live FX rates move the derived EUR value every run.
    expect(observationPayloadHash(auction({ marketValue: 100, currency: 'CZK', marketValueEur: 4 })))
      .toBe(observationPayloadHash(auction({ marketValue: 100, currency: 'CZK', marketValueEur: 5 })))
    // A crawler that sets only the EUR value: that is the price itself.
    expect(observationPayloadHash(auction({ marketValueEur: 250000 })))
      .not.toBe(observationPayloadHash(auction({ marketValueEur: 240000 })))
  })
})

describe('recordObservations', () => {
  const capturedAt = '2026-07-17T12:00:00.000Z'
  let heads: Array<{ platform: string; external_id: string; payload_hash: string; captured_at: string }>

  beforeEach(() => {
    heads = []
    query.mockReset().mockImplementation(async (sql: string) => (
      sql.startsWith('SELECT platform, external_id, payload_hash') ? { rows: heads } : { rows: [] }
    ))
  })

  const result = (...auctions: Auction[]) => ({ auctions, errors: [] }) as never
  const inserts = () => query.mock.calls.filter(([sql]) => String(sql).startsWith('INSERT INTO auction_observations '))
  const headWrites = () => query.mock.calls.filter(([sql]) => String(sql).startsWith('INSERT INTO auction_observation_heads'))
  const head = (a: Auction, at: string) => ({
    platform: a.platform, external_id: a.externalId, payload_hash: observationPayloadHash(a), captured_at: at,
  })

  it('writes the first observation of an auction and stores its head', async () => {
    await recordObservations(result(auction()), capturedAt, 'list')

    expect(inserts()).toHaveLength(1)
    const [, values] = headWrites()[0]!
    expect(values).toEqual(['list', capturedAt, ['test'], ['42'], [observationPayloadHash(auction())]])
  })

  it('skips an unchanged payload of the same kind', async () => {
    heads = [head(auction(), '2026-07-17T11:00:00.000Z')]

    await recordObservations(result(auction()), capturedAt, 'list')

    expect(inserts()).toHaveLength(0)
    expect(headWrites()).toHaveLength(0)
  })

  it('writes a changed payload', async () => {
    heads = [head(auction(), '2026-07-17T11:00:00.000Z')]

    await recordObservations(result(auction({ cancelled: true })), capturedAt, 'list')

    expect(inserts()).toHaveLength(1)
    expect(headWrites()).toHaveLength(1)
  })

  it('writes an unchanged detail payload once a day, never an unchanged list payload', async () => {
    heads = [head(auction(), '2026-07-16T15:00:00.000Z')]

    await recordObservations(result(auction()), capturedAt, 'list')
    expect(inserts()).toHaveLength(0)

    await recordObservations(result(auction()), capturedAt, 'detail')
    expect(inserts()).toHaveLength(1)
  })

  it('keeps an unchanged detail payload out within the day', async () => {
    heads = [head(auction(), '2026-07-17T06:00:00.000Z')]

    await recordObservations(result(auction()), capturedAt, 'detail')

    expect(inserts()).toHaveLength(0)
  })

  it('writes a duplicate auction in one result once and stores one head for it', async () => {
    await recordObservations(result(auction(), auction()), capturedAt, 'list')

    const [, values] = inserts()[0]!
    expect((values as unknown[]).filter((value) => value === '42')).toHaveLength(1)
    expect(headWrites()[0]![1]).toEqual(['list', capturedAt, ['test'], ['42'], [observationPayloadHash(auction())]])
  })
})
