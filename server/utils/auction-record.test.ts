import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPool } from './db'

vi.mock('./db', () => ({ getPool: vi.fn() }))

const { readAuctionRecord } = await import('./auction-record')

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
