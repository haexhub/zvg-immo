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
      // 37 columns per row, in COLUMNS order: platform, external_id are first two.
      for (let i = 0; i < params.length; i += 37) {
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

  it('derives missing land_area_sqm from complete parcel data before flattening for any platform', () => {
    const a = makeAuction({
      platform: 'generic-source',
      extraction: {
        propertyType: 'einfamilienhaus',
        landAreaSqm: null,
        livingAreaSqm: 180,
        rooms: null,
        units: null,
        planningNotes: {
          monumentProtection: null,
          contamination: null,
          developmentPlan: null,
          landConsolidation: null,
          developmentCharges: null,
          redevelopmentArea: null,
          conservationArea: null,
          landParcels: [
            { label: 'Parcelle A', areaSqm: 500, use: null },
            { label: 'Parcelle B', areaSqm: 816, use: null },
          ],
        },
        source: 'rules',
        confidence: 'high',
        at: '2026-07-21T00:00:00.000Z',
      },
    })

    const row = auctionToCurrentRow(a, '2026-07-21T00:00:00.000Z')

    expect(row.land_area_sqm).toBe(1316)
  })

  it('nulls extraction-derived fields when there is no extraction yet', () => {
    const row = auctionToCurrentRow(makeAuction(), '2026-07-21T00:00:00.000Z')
    expect(row.property_type).toBeNull()
    expect(row.living_area_sqm).toBeNull()
    expect(row.extraction_source).toBeNull()
    expect(row.condition).toBeNull()
    expect(row.features).toBeNull()
    expect(row.starting_bid).toBeNull()
    expect(row.current_bid).toBeNull()
    expect(row.source_security_deposit).toBeNull()
    expect(row.security_deposit).toBeNull()
    expect(row.bidding_notes).toBeNull()
  })

  it('flattens WP-1/WP-2 fields (condition, features, bid/security-deposit) onto the row', () => {
    const a = makeAuction({
      startingBid: 50000,
      currentBid: 52000,
      sourceSecurityDeposit: 5000,
      extraction: {
        propertyType: 'einfamilienhaus',
        landAreaSqm: null,
        livingAreaSqm: null,
        rooms: null,
        units: null,
        securityDeposit: 5000,
        biddingNotes: 'Zahlung binnen 14 Tagen',
        condition: 'gepflegt',
        features: ['balkon', 'keller'],
        source: 'llm',
        confidence: 'high',
        at: '2026-07-21T00:00:00.000Z',
      },
    })
    const row = auctionToCurrentRow(a, '2026-07-21T00:00:00.000Z')
    expect(row.condition).toBe('"gepflegt"')
    expect(row.features).toEqual(['balkon', 'keller'])
    expect(row.starting_bid).toBe(50000)
    expect(row.current_bid).toBe(52000)
    expect(row.source_security_deposit).toBe(5000)
    expect(row.security_deposit).toBe(5000)
    expect(row.bidding_notes).toBe('Zahlung binnen 14 Tagen')
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

  it('collapses duplicate (platform, external_id) rows to last-wins', async () => {
    // crawlAll can emit the same auction twice (a platform registered for
    // several regions). A duplicate conflict key in one VALUES list makes
    // Postgres reject the whole statement, so they must be deduped first.
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    await upsertCurrentAuctions(
      [
        makeAuction(),
        makeAuction({ extraction: {
          propertyType: null, landAreaSqm: null, livingAreaSqm: 250, rooms: null, units: null,
          source: 'rules', confidence: 'low', at: '2026-07-21T00:00:00.000Z',
        } }),
      ],
      '2026-07-21T00:00:00.000Z',
    )

    expect(pool.rows).toEqual([
      { platform: 'zvg-portal', external_id: '7265', living_area_sqm: 250 },
    ])
  })

  it('surfaces a query failure so a run cannot report success after data loss', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('connection reset')) }
    vi.mocked(getPool).mockReturnValue(pool as never)
    await expect(upsertCurrentAuctions([makeAuction()], '2026-07-21T00:00:00.000Z')).rejects.toThrow('connection reset')
  })
})
