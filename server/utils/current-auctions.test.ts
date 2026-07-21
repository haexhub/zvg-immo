import { describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import { getPool } from './db'

vi.mock('./db', () => ({ getPool: vi.fn() }))

const { auctionToCurrentRow, upsertCurrentAuctions } = await import('./current-auctions')

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

/** Minimal in-memory stand-in for the `pg` Pool. */
function makeFakePool() {
  const rows: Array<{ platform: string; external_id: string; living_area_sqm: number | null }> = []
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO auctions')) {
      // 27 columns per row, in COLUMNS order: platform, external_id are first two.
      for (let i = 0; i < params.length; i += 27) {
        rows.push({
          platform: params[i] as string,
          external_id: params[i + 1] as string,
          living_area_sqm: params[i + 11] as number | null,
        })
      }
      return { rows: [], rowCount: rows.length }
    }
    throw new Error(`unexpected query: ${sql}`)
  })
  return { rows, query }
}

describe('auctionToCurrentRow', () => {
  it('flattens extraction fields onto the row', () => {
    const a = makeAuction({
      extraction: {
        propertyType: 'einfamilienhaus',
        landAreaSqm: 1884,
        livingAreaSqm: 447,
        rooms: null,
        units: null,
        source: 'llm',
        confidence: 'high',
        at: '2026-07-21T00:00:00.000Z',
      },
    })
    const row = auctionToCurrentRow(a, '2026-07-21T00:00:00.000Z')
    expect(row.property_type).toBe('einfamilienhaus')
    expect(row.living_area_sqm).toBe(447)
    expect(row.land_area_sqm).toBe(1884)
    expect(row.extraction_source).toBe('llm')
    expect(row.extraction_confidence).toBe('high')
  })

  it('nulls extraction-derived fields when there is no extraction yet', () => {
    const row = auctionToCurrentRow(makeAuction(), '2026-07-21T00:00:00.000Z')
    expect(row.property_type).toBeNull()
    expect(row.living_area_sqm).toBeNull()
    expect(row.extraction_source).toBeNull()
  })
})

describe('upsertCurrentAuctions', () => {
  it('is a no-op without a configured pool', async () => {
    vi.mocked(getPool).mockReturnValue(null)
    await expect(upsertCurrentAuctions([makeAuction()], '2026-07-21T00:00:00.000Z')).resolves.toBeUndefined()
  })

  it('upserts one row per auction', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    await upsertCurrentAuctions(
      [makeAuction(), makeAuction({ externalId: '7266', extraction: {
        propertyType: null, landAreaSqm: null, livingAreaSqm: 100, rooms: null, units: null,
        source: 'rules', confidence: 'low', at: '2026-07-21T00:00:00.000Z',
      } })],
      '2026-07-21T00:00:00.000Z',
    )

    expect(pool.rows).toEqual([
      { platform: 'zvg-portal', external_id: '7265', living_area_sqm: null },
      { platform: 'zvg-portal', external_id: '7266', living_area_sqm: 100 },
    ])
  })

  it('never throws when the query fails', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('connection reset')) }
    vi.mocked(getPool).mockReturnValue(pool as never)
    await expect(upsertCurrentAuctions([makeAuction()], '2026-07-21T00:00:00.000Z')).resolves.toBeUndefined()
  })
})
