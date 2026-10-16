import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPool } from './db'

vi.mock('./db', () => ({ getPool: vi.fn() }))

const {
  createCandidateRecordLoader,
  iterateAuctionRecords,
  readAuctionRecord,
  readAuctionRecords,
  readAuctionRecordsByKeys,
} = await import('./auction-record')

afterEach(() => {
  vi.clearAllMocks()
})

describe('readAuctionRecord', () => {
  it('combines the latest structured details, fetch state, provenance and separately loaded photos', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM auction_photos')) {
        return {
          rows: [{
            auction_details_id: '42',
            ordinal: 0,
            file: 'front.jpg',
            category: 'aussen',
            caption: 'Straßenansicht',
            is_property_photo: true,
            appeal_score: 93,
          }],
        }
      }
      return {
        rows: [{
          platform: 'zvg-portal',
          external_id: '7265',
          country: 'de',
          region: 'Brandenburg',
          authority: 'Neuruppin',
          case_number: '7 K 168/25',
          title: 'Einfamilienhaus',
          auction_date_iso: new Date('2026-10-15T14:00:00.000Z'),
          auction_date_text: '15.10.2026, 16:00 Uhr',
          cancelled: false,
          current_address: 'Berliner Tor 2, Angermünde',
          current_description: 'Beschreibung',
          current_photo_count: 1,
          current_thumbnail_url: '/api/auction-image/x',
          current_lat: '52.1',
          current_lng: '13.2',
          details_id: '42',
          details_version: 3,
          artifact_version_id: '17',
          extracted_at: new Date('2026-08-01T10:00:00.000Z'),
          property_type: 'einfamilienhaus',
          land_area_sqm: '500',
          living_area_sqm: '120',
          rooms: '4',
          bedrooms: '3',
          bathrooms: '1',
          floor: null,
          bathroom_has_tub: true,
          bathroom_has_shower: false,
          heating: 'Gas',
          units: 1,
          year_built: 1968,
          last_renovation_year: 2010,
          market_value: '250000',
          currency: 'EUR',
          market_value_eur: '250000',
          market_value_text: '250.000 EUR laut Gutachten',
          condition: 'gepflegt',
          features: ['garage'],
          insights: null,
          planning_notes: null,
          renovation_notes: null,
          starting_bid: null,
          current_bid: null,
          source_security_deposit: null,
          security_deposit: null,
          bidding_notes: null,
          extraction_source: 'llm',
          extraction_confidence: 'high',
          llm_analyzed_at: new Date('2026-08-01T10:00:00.000Z'),
          document_summary: 'Zusammenfassung',
          source_living_area_sqm: '121',
          source_land_area_sqm: '501',
          source_rooms: '4.5',
          pdf_url: '/api/pdf',
          pdf_url_upstream: 'https://example.test/doc.pdf',
          detail_url: '/api/detail',
          detail_url_upstream: 'https://example.test/detail',
          attachments: [],
          photo_urls: ['https://example.test/front.jpg'],
          source_updated_iso: new Date('2026-07-31T12:00:00.000Z'),
          detail_fetched_at: new Date('2026-08-01T09:00:00.000Z'),
          llm_batch_job: null,
          llm_failures: 0,
          photos_checked_at: new Date('2026-08-01T09:30:00.000Z'),
          photo_failures: 0,
          photo_pipeline_version: 5,
        }],
      }
    })
    vi.mocked(getPool).mockReturnValue({ query } as never)

    const record = await readAuctionRecord('zvg-portal', '7265')

    expect(record).toMatchObject({
      detailsId: 42,
      detailsVersion: 3,
      artifactVersionId: 17,
      auction: {
        auctionDateText: '15.10.2026, 16:00 Uhr',
        marketValueEur: 250000,
        sourceLivingAreaSqm: 121,
        pdfUrl: '/api/pdf',
        extraction: {
          propertyType: 'einfamilienhaus',
          photos: [{ file: 'front.jpg', category: 'aussen', caption: 'Straßenansicht', isPropertyPhoto: true, appealScore: 93 }],
        },
      },
    })
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[0]?.[0]).toContain('LEFT JOIN LATERAL')
    expect(query.mock.calls[0]?.[0]).toContain('LEFT JOIN auction_fetch_state')
    expect(query.mock.calls[1]?.[0]).toContain('FROM auction_photos')
  })
})

/** A row with only the identity filled in; every other column is null, which
 *  fromRow maps to an empty record — enough to test the loading strategy. */
function bareRow(platform: string, externalId: string) {
  return {
    platform, external_id: externalId, country: 'de', region: 'Berlin', authority: 'AG', case_number: '1 K 1/26', title: null,
    auction_date_iso: null, auction_date_text: null, cancelled: false, current_address: null, current_description: null,
    current_photo_count: null, current_thumbnail_url: null, current_lat: null, current_lng: null, details_id: null,
    details_version: null, artifact_version_id: null, extracted_at: null, extraction_source: null, extraction_confidence: null,
    attachments: null, photo_urls: null,
  }
}

async function drain<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of source) out.push(item)
  return out
}

describe('iterateAuctionRecords', () => {
  it('pages by keyset in platform/external_id order and stops at a short chunk', async () => {
    const pages = [
      [bareRow('a', '1'), bareRow('a', '2')],
      [bareRow('b', '1'), bareRow('b', '2')],
      [bareRow('c', '1')],
    ]
    const query = vi.fn(async () => ({ rows: pages.shift() ?? [] }))
    vi.mocked(getPool).mockReturnValue({ query } as never)

    const records = await drain(iterateAuctionRecords(undefined, { includePhotos: false, chunkSize: 2 }))

    expect(records.map((r) => `${r.auction.platform}:${r.auction.externalId}`)).toEqual(['a:1', 'a:2', 'b:1', 'b:2', 'c:1'])
    expect(query).toHaveBeenCalledTimes(3)
    const [firstSql, firstParams] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(firstSql).not.toContain('(a.platform, a.external_id) >')
    expect(firstSql).toContain('ORDER BY a.platform, a.external_id LIMIT $1')
    expect(firstParams).toEqual([2])
    const [secondSql, secondParams] = query.mock.calls[1] as unknown as [string, unknown[]]
    expect(secondSql).toContain('(a.platform, a.external_id) > ($1, $2)')
    expect(secondParams).toEqual(['a', '2', 2])
  })

  it('asks once more after an exactly full chunk and stops on the empty page', async () => {
    const pages = [[bareRow('a', '1'), bareRow('a', '2')], []]
    const query = vi.fn(async () => ({ rows: pages.shift() ?? [] }))
    vi.mocked(getPool).mockReturnValue({ query } as never)

    expect(await drain(iterateAuctionRecords(undefined, { includePhotos: false, chunkSize: 2 }))).toHaveLength(2)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('scopes to a country and keeps the country filter on every page', async () => {
    const pages = [[bareRow('a', '1')], []]
    const query = vi.fn(async () => ({ rows: pages.shift() ?? [] }))
    vi.mocked(getPool).mockReturnValue({ query } as never)

    await drain(iterateAuctionRecords('de', { includePhotos: false, chunkSize: 1 }))

    const [sql, params] = query.mock.calls[1] as unknown as [string, unknown[]]
    expect(sql).toContain('a.country = $1 AND (a.platform, a.external_id) > ($2, $3)')
    expect(params).toEqual(['de', 'a', '1', 1])
  })

  it('loads photos per chunk by default, only for that chunk', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('auction_photos')
      ? { rows: [] }
      : { rows: [{ ...bareRow('a', '1'), details_id: '5' }] })
    vi.mocked(getPool).mockReturnValue({ query } as never)

    await drain(iterateAuctionRecords(undefined, { chunkSize: 10 }))

    const photoCall = query.mock.calls.find(([sql]) => String(sql).includes('auction_photos')) as unknown as [string, unknown[]]
    expect(photoCall[1]).toEqual([['5']])
  })

  it('yields nothing without a database', async () => {
    vi.mocked(getPool).mockReturnValue(null as never)
    expect(await drain(iterateAuctionRecords())).toEqual([])
  })
})

describe('readAuctionRecordsByKeys', () => {
  it('reads exactly the requested keys through unnest and keys the result like the record map', async () => {
    const query = vi.fn(async () => ({ rows: [bareRow('zvg-portal', '7'), bareRow('bg-alo', '9')] }))
    vi.mocked(getPool).mockReturnValue({ query } as never)

    const records = await readAuctionRecordsByKeys(
      [{ platform: 'zvg-portal', externalId: '7' }, { platform: 'bg-alo', externalId: '9' }, { platform: 'x', externalId: 'gone' }],
      { includePhotos: false },
    )

    expect([...records.keys()].sort()).toEqual(['bg-alo:9', 'zvg-portal:7'])
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('unnest($1::text[], $2::text[])')
    expect(params).toEqual([['zvg-portal', 'bg-alo', 'x'], ['7', '9', 'gone']])
  })

  it('splits a long key list into bounded queries', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    vi.mocked(getPool).mockReturnValue({ query } as never)
    const keys = Array.from({ length: 1200 }, (_, i) => ({ platform: 'p', externalId: String(i) }))

    await readAuctionRecordsByKeys(keys, { includePhotos: false })

    expect(query).toHaveBeenCalledTimes(3)
    expect((query.mock.calls[0] as unknown as [string, string[][]])[1][0]).toHaveLength(500)
    expect((query.mock.calls[2] as unknown as [string, string[][]])[1][0]).toHaveLength(200)
  })
})

describe('createCandidateRecordLoader', () => {
  const candidates = Array.from({ length: 5 }, (_, i) => ({ platform: 'p', externalId: String(i) }))

  function stubByKeys() {
    const query = vi.fn(async (_sql: string, params: string[][]) => ({
      rows: params[1]!.map((id) => ({ ...bareRow('p', id) })),
    }))
    vi.mocked(getPool).mockReturnValue({ query } as never)
    return query
  }

  it('reads one chunk at a time and reuses it for the candidates inside it', async () => {
    const query = stubByKeys()
    const loader = createCandidateRecordLoader(candidates, 2)

    expect((await loader.get('p', '0'))?.auction.externalId).toBe('0')
    expect((await loader.get('p', '1'))?.auction.externalId).toBe('1')
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]![1]).toEqual([['p', 'p'], ['0', '1']])

    expect((await loader.get('p', '2'))?.auction.externalId).toBe('2')
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[1]![1]).toEqual([['p', 'p'], ['2', '3']])
  })

  it('drops the previous chunk: going back re-reads it instead of holding everything', async () => {
    const query = stubByKeys()
    const loader = createCandidateRecordLoader(candidates, 2)

    await loader.get('p', '0')
    await loader.get('p', '4')
    await loader.get('p', '0')

    expect(query).toHaveBeenCalledTimes(3)
  })

  it('returns undefined for an unknown candidate without querying', async () => {
    const query = stubByKeys()
    const loader = createCandidateRecordLoader(candidates, 2)

    expect(await loader.get('p', 'nope')).toBeUndefined()
    expect(query).not.toHaveBeenCalled()
  })

  it('returns undefined for a candidate whose row has disappeared', async () => {
    vi.mocked(getPool).mockReturnValue({ query: vi.fn(async () => ({ rows: [] })) } as never)
    const loader = createCandidateRecordLoader(candidates, 2)

    expect(await loader.get('p', '1')).toBeUndefined()
  })
})

describe('readAuctionRecords full-load gate', () => {
  it('runs whole-table loads one after another, never side by side', async () => {
    let active = 0
    let maxActive = 0
    const query = vi.fn(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return { rows: [] }
    })
    vi.mocked(getPool).mockReturnValue({ query } as never)

    await Promise.all([
      readAuctionRecords(undefined, { includePhotos: false }),
      readAuctionRecords(undefined, { includePhotos: false }),
      readAuctionRecords('de', { includePhotos: false }),
    ])

    expect(query).toHaveBeenCalledTimes(3)
    expect(maxActive).toBe(1)
  })

  it('keeps going after a failed load', async () => {
    const query = vi.fn()
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce({ rows: [bareRow('a', '1')] })
    vi.mocked(getPool).mockReturnValue({ query } as never)

    const first = readAuctionRecords(undefined, { includePhotos: false })
    const second = readAuctionRecords(undefined, { includePhotos: false })

    await expect(first).rejects.toThrow('connection lost')
    await expect(second).resolves.toHaveLength(1)
  })
})
