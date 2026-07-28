import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Auction, AuctionExtraction } from '~/types/auction'
import { applyExtractionToAuctions, type ExtractionCache } from './extraction-cache'

vi.mock('./db', () => ({ getPool: vi.fn() }))

function makeAuction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'zvg-portal',
    country: 'de',
    region: 'Berlin',
    externalId: '14409',
    caseNumber: '70 K 7/25',
    authority: 'AG Köpenick',
    title: null,
    address: 'Paradiesstraße 214-218, Berlin-Köpenick',
    marketValueEur: null,
    marketValueText: null,
    auctionDateIso: '2026-09-01T09:00:00.000Z',
    auctionDateText: '01.09.2026',
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

const extraction: AuctionExtraction = {
  propertyType: 'einfamilienhaus',
  landAreaSqm: 1884,
  livingAreaSqm: 447,
  rooms: null,
  units: null,
  source: 'llm',
  confidence: 'high',
  at: '2026-07-21T00:00:00.000Z',
}

/** Minimal in-memory stand-in for the `pg` Pool. */
function makeFakePool(rows: Array<{ platform: string; external_id: string; extraction: AuctionExtraction }> = []) {
  const upserted: Array<{ platform: string; external_id: string; extraction: AuctionExtraction }> = []
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT platform, external_id, extraction FROM extraction_cache')) {
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('INSERT INTO extraction_cache')) {
      for (let i = 0; i < params.length; i += 3) {
        upserted.push({
          platform: params[i] as string,
          external_id: params[i + 1] as string,
          extraction: JSON.parse(params[i + 2] as string),
        })
      }
      return { rows: [], rowCount: params.length / 3 }
    }
    throw new Error(`unexpected query: ${sql}`)
  })
  return { query, upserted }
}

// readExtractionCache() memoizes the loaded cache at module scope for the
// process's lifetime, so each test re-imports the module fresh to isolate
// that state (same pattern as geocode.test.ts's backend-selection tests).
afterEach(() => {
  vi.resetModules()
})

describe('readExtractionCache', () => {
  it('returns an empty cache when Postgres is not configured', async () => {
    const { getPool } = await import('./db')
    vi.mocked(getPool).mockReturnValue(null)
    const { readExtractionCache } = await import('./extraction-cache')

    await expect(readExtractionCache()).resolves.toEqual({})
  })

  it('loads every row from Postgres on first call', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool([{ platform: 'zvg-portal', external_id: '7265', extraction }])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { readExtractionCache } = await import('./extraction-cache')

    const cache = await readExtractionCache()

    expect(cache['zvg-portal:7265']).toEqual(extraction)
  })

  it('normalizes derived parcel land area while loading rows for any platform', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool([{
      platform: 'generic-source',
      external_id: '7265',
      extraction: {
        ...extraction,
        landAreaSqm: null,
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
      },
    }])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { readExtractionCache } = await import('./extraction-cache')

    const cache = await readExtractionCache()

    expect(cache['generic-source:7265']?.landAreaSqm).toBe(1316)
  })

  it('serves subsequent calls from memory without re-querying Postgres', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool([{ platform: 'zvg-portal', external_id: '7265', extraction }])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { readExtractionCache } = await import('./extraction-cache')

    await readExtractionCache()
    await readExtractionCache()

    expect(pool.query).toHaveBeenCalledTimes(1)
  })

  it('retries on the next call after a failed load, without caching the failure', async () => {
    const { getPool } = await import('./db')
    const failingPool = { query: vi.fn().mockRejectedValue(new Error('connection reset')) }
    vi.mocked(getPool).mockReturnValue(failingPool as never)
    const { readExtractionCache } = await import('./extraction-cache')

    await expect(readExtractionCache()).resolves.toEqual({})

    const workingPool = makeFakePool([{ platform: 'zvg-portal', external_id: '7265', extraction }])
    vi.mocked(getPool).mockReturnValue(workingPool as never)

    const cache = await readExtractionCache()

    expect(cache['zvg-portal:7265']).toEqual(extraction)
  })
})

describe('writeExtractionCache', () => {
  it('is a no-op towards Postgres without a configured pool, but still updates the in-process cache', async () => {
    const { getPool } = await import('./db')
    vi.mocked(getPool).mockReturnValue(null)
    const { readExtractionCache, writeExtractionCache } = await import('./extraction-cache')

    await writeExtractionCache({ 'zvg-portal:7265': extraction })

    const cache = await readExtractionCache()
    expect(cache['zvg-portal:7265']).toEqual(extraction)
  })

  it('upserts only the given entries, not the full in-process cache', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool([{ platform: 'zvg-portal', external_id: '1111', extraction }])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { readExtractionCache, writeExtractionCache } = await import('./extraction-cache')

    // Load the existing entry into the in-process cache first...
    await readExtractionCache()
    // ...then write only a second, unrelated entry.
    const second: AuctionExtraction = { ...extraction, confidence: 'low' }
    await writeExtractionCache({ 'zvg-portal:2222': second })

    expect(pool.upserted).toEqual([{ platform: 'zvg-portal', external_id: '2222', extraction: second }])
  })

  it('persists normalized derived parcel land area on write for any platform', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { writeExtractionCache } = await import('./extraction-cache')

    await writeExtractionCache({
      'generic-source:2222': {
        ...extraction,
        landAreaSqm: null,
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
      },
    })

    expect(pool.upserted[0]?.extraction.landAreaSqm).toBe(1316)
  })

  it('merges written entries into the in-process cache for subsequent reads', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { readExtractionCache, writeExtractionCache } = await import('./extraction-cache')

    await writeExtractionCache({ 'zvg-portal:7265': extraction })
    const cache = await readExtractionCache()

    expect(cache['zvg-portal:7265']).toEqual(extraction)
    // The merge is served from memory — no second SELECT round-trip.
    const selectCalls = pool.query.mock.calls.filter(([sql]) => (sql as string).includes('SELECT'))
    expect(selectCalls).toHaveLength(1)
  })

  it('never throws when the query fails', async () => {
    const { getPool } = await import('./db')
    vi.mocked(getPool).mockReturnValue({ query: vi.fn().mockRejectedValue(new Error('connection reset')) } as never)
    const { writeExtractionCache } = await import('./extraction-cache')

    await expect(writeExtractionCache({ 'zvg-portal:7265': extraction })).resolves.toBe(false)
  })
})

describe('applyExtractionToAuctions — marketValueEur precedence (WP-3)', () => {
  it('derives missing landAreaSqm from complete landParcels before exposing the extraction', () => {
    const auction = makeAuction()
    const cache: ExtractionCache = {
      'zvg-portal:14409': {
        ...extraction,
        landAreaSqm: null,
        planningNotes: {
          monumentProtection: null,
          contamination: null,
          developmentPlan: null,
          landConsolidation: null,
          developmentCharges: null,
          redevelopmentArea: null,
          conservationArea: null,
          landParcels: [{ label: '743/1', areaSqm: 1316, use: null }],
        },
      },
    }

    applyExtractionToAuctions([auction], cache)

    expect(auction.extraction?.landAreaSqm).toBe(1316)
  })

  it('fills marketValueEur/marketValueText from the LLM extraction when the auction has none', () => {
    const auction = makeAuction()
    const cache: ExtractionCache = {
      'zvg-portal:14409': {
        ...extraction,
        marketValueEur: 185_000,
        marketValueText: '185.000 EUR laut Gutachten',
      },
    }

    applyExtractionToAuctions([auction], cache)

    expect(auction.marketValueEur).toBe(185_000)
    expect(auction.marketValueText).toBe('185.000 EUR laut Gutachten')
  })

  it('never overwrites a structurally known marketValueEur (e.g. AT-Edikte/Biddit) with the LLM value', () => {
    const auction = makeAuction({ marketValueEur: 250_000, marketValueText: '250.000 EUR' })
    const cache: ExtractionCache = {
      'zvg-portal:14409': {
        ...extraction,
        marketValueEur: 185_000,
        marketValueText: '185.000 EUR laut Gutachten',
      },
    }

    applyExtractionToAuctions([auction], cache)

    expect(auction.marketValueEur).toBe(250_000)
    expect(auction.marketValueText).toBe('250.000 EUR')
  })

  it('leaves marketValueEur null when the LLM found none either', () => {
    const auction = makeAuction()
    const cache: ExtractionCache = { 'zvg-portal:14409': { ...extraction, marketValueEur: null } }

    applyExtractionToAuctions([auction], cache)

    expect(auction.marketValueEur).toBeNull()
  })

  it('leaves marketValueEur untouched when the cache entry never checked (undefined)', () => {
    const auction = makeAuction()
    const cache: ExtractionCache = { 'zvg-portal:14409': { ...extraction } }

    applyExtractionToAuctions([auction], cache)

    expect(auction.marketValueEur).toBeNull()
  })

  it('does not fill marketValueEur for a non-EUR-native auction (LLM value is in the native currency, not EUR)', () => {
    const auction = makeAuction({ platform: 'hu', currency: 'HUF' })
    const cache: ExtractionCache = {
      'hu:14409': {
        ...extraction,
        marketValueEur: 50_000_000,
        marketValueText: '50.000.000 HUF laut Gutachten',
      },
    }

    applyExtractionToAuctions([auction], cache)

    expect(auction.marketValueEur).toBeNull()
    expect(auction.marketValueText).toBeNull()
  })
})

describe('applyExtractionToAuctions — photo ordering', () => {
  it('reorders extraction.photos so the LLM-curated real photo leads, not whichever file the pipeline mined first', () => {
    const auction = makeAuction()
    const cache: ExtractionCache = {
      'zvg-portal:14409': {
        ...extraction,
        photos: [
          { file: 'energieausweis.jpg', category: 'sonstiges', caption: null, isPropertyPhoto: false },
          { file: 'hausansicht.jpg', category: 'aussen', caption: null, isPropertyPhoto: true },
        ],
      },
    }

    applyExtractionToAuctions([auction], cache)

    expect(auction.extraction?.photos?.map((p) => p.file)).toEqual(['hausansicht.jpg', 'energieausweis.jpg'])
    expect(auction.thumbnailUrl).toBe('/api/auction-image/zvg-portal/14409/hausansicht.jpg')
  })

  it('normalizes legacy bare-filename rows before sorting them', () => {
    const auction = makeAuction()
    const cache: ExtractionCache = {
      'zvg-portal:14409': {
        ...extraction,
        photos: ['a.jpg', 'b.jpg'] as unknown as AuctionExtraction['photos'],
      },
    }

    applyExtractionToAuctions([auction], cache)

    expect(auction.extraction?.photos?.map((p) => p.file)).toEqual(['a.jpg', 'b.jpg'])
  })
})
