import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchAllListings,
  indexIncluded,
  mapOffer,
  type IncludedJson,
  type OfferJson,
  type SearchResponse,
} from './list'

function makeOffer(overrides: Partial<OfferJson['attributes']> = {}, id = '19454'): OfferJson {
  return {
    id,
    type: 'real_estate_offer',
    attributes: {
      offer_id: 'DOVK.VK-147327/0009-01.2005.KH',
      title: 'Schöne Doppelhaushälften mit Garten in zentrumsnaher Lage',
      street: 'Eckenerstraße',
      house_number: '4a',
      postcode: '32756',
      city: 'Detmold',
      show_address: true,
      latitude: 51.948186,
      longitude: 8.8905277,
      buy_price: 222000,
      living_space: 120,
      plot_area: 433,
      number_of_rooms: 6,
      description_note: 'Gepflegte Doppelhaushälfte.',
      location_note: 'Ruhige Wohnlage am Stadtrand.',
      furnishing_note: null,
      other_note: null,
      updated_at: '2026-08-14T10:32:17.924Z',
      ...overrides,
    },
    relationships: {
      expose: { data: { id: 'exp-1', type: 'expose' } },
      images: {
        data: [
          { id: 'img-2', type: 'image' },
          { id: 'img-1', type: 'image' },
        ],
      },
      downloads: { data: [{ id: 'dl-1', type: 'download' }] },
    },
  }
}

const INCLUDED: IncludedJson[] = [
  {
    id: 'exp-1',
    type: 'expose',
    attributes: { url: 'https://api.bundesimmobilien.de/asset-service/assets/exp/public/original', title: 'Exposé', name: 'expose.pdf' },
  },
  {
    id: 'img-1',
    type: 'image',
    attributes: { url: 'https://api.bundesimmobilien.de/asset-service/assets/img1/public/original', position: 1 },
  },
  {
    id: 'img-2',
    type: 'image',
    attributes: { url: 'https://api.bundesimmobilien.de/asset-service/assets/img2/public/original', position: 2 },
  },
  {
    id: 'dl-1',
    type: 'download',
    attributes: {
      url: 'https://api.bundesimmobilien.de/asset-service/assets/dl1/public/original',
      title: 'Widerrufsbelehrung / Widerruf',
      name: 'Widerrufsbelehrung-Widerrufsformular.pdf',
      content_length: 163649,
    },
  },
]

describe('mapOffer', () => {
  it('maps a fully populated BUY listing', () => {
    const byKey = indexIncluded(INCLUDED)
    const a = mapOffer(makeOffer(), byKey, 'bima')

    expect(a.platform).toBe('bima')
    expect(a.country).toBe('de')
    expect(a.region).toBe('')
    expect(a.externalId).toBe('19454')
    expect(a.caseNumber).toBe('DOVK.VK-147327/0009-01.2005.KH')
    expect(a.authority).toBe('Bundesanstalt für Immobilienaufgaben (BImA)')
    expect(a.title).toBe('Schöne Doppelhaushälften mit Garten in zentrumsnaher Lage')
    expect(a.address).toBe('Eckenerstraße 4a, 32756 Detmold')
    expect(a.marketValueEur).toBe(222000)
    expect(a.marketValueText).toBe('222.000 €')
    expect(a.auctionDateIso).toBeNull()
    expect(a.auctionDateText).toBeNull()
    expect(a.cancelled).toBe(false)
    expect(a.detailUrl).toBe('https://immobilienportal.bundesimmobilien.de/details?id=19454')
    expect(a.detailUrlUpstream).toBe(a.detailUrl)
    expect(a.sourceLivingAreaSqm).toBe(120)
    expect(a.sourceLandAreaSqm).toBe(433)
    expect(a.sourceRooms).toBe(6)
    expect(a.lat).toBe(51.948186)
    expect(a.lng).toBe(8.8905277)
  })

  it('orders photos by their position attribute, not relationship order', () => {
    const byKey = indexIncluded(INCLUDED)
    const a = mapOffer(makeOffer(), byKey, 'bima')
    // relationships list img-2 before img-1, but img-1 has the lower position
    expect(a.photoUrls).toEqual([
      'https://api.bundesimmobilien.de/asset-service/assets/img1/public/original',
      'https://api.bundesimmobilien.de/asset-service/assets/img2/public/original',
    ])
    expect(a.photoCount).toBe(2)
    expect(a.thumbnailUrl).toBe(a.photoUrls![0])
  })

  it('lists the official Exposé as a brochure attachment and classifies plain downloads', () => {
    const byKey = indexIncluded(INCLUDED)
    const a = mapOffer(makeOffer(), byKey, 'bima')
    expect(a.attachments).toHaveLength(2)
    expect(a.attachments[0]).toMatchObject({ kind: 'brochure', label: 'Exposé', fileId: 'exp-1' })
    expect(a.attachments[1]).toMatchObject({
      kind: 'other',
      label: 'Widerrufsbelehrung / Widerruf',
      fileId: 'dl-1',
      sizeBytes: 163649,
    })
  })

  it('composes the description from the labelled note sections that are present', () => {
    const byKey = indexIncluded(INCLUDED)
    const a = mapOffer(makeOffer(), byKey, 'bima')
    expect(a.description).toBe('Objektbeschreibung\nGepflegte Doppelhaushälfte.\n\nLage\nRuhige Wohnlage am Stadtrand.')
  })

  it('hides the address entirely when show_address is false, matching the live detail page', () => {
    const byKey = indexIncluded(INCLUDED)
    const a = mapOffer(makeOffer({ show_address: false }), byKey, 'bima')
    expect(a.address).toBeNull()
  })

  it('treats a zero/missing buy_price as unknown rather than free', () => {
    const byKey = indexIncluded(INCLUDED)
    const a = mapOffer(makeOffer({ buy_price: 0 }), byKey, 'bima')
    expect(a.marketValueEur).toBeNull()
    expect(a.marketValueText).toBeNull()

    const b = mapOffer(makeOffer({ buy_price: null }), byKey, 'bima')
    expect(b.marketValueEur).toBeNull()
  })

  it('treats BImA\'s 1 € best-offer placeholder as unknown, but keeps a real auction limit', () => {
    const byKey = indexIncluded(INCLUDED)
    const placeholder = mapOffer(makeOffer({ buy_price: 1 }), byKey, 'bima')
    expect(placeholder.marketValueEur).toBeNull()
    expect(placeholder.marketValueText).toBeNull()

    const auctionLimit = mapOffer(makeOffer({ buy_price: 10 }), byKey, 'bima')
    expect(auctionLimit.marketValueEur).toBe(10)
    expect(auctionLimit.marketValueText).toBe('10 €')
  })

  it('falls back to empty caseNumber, no photos/attachments/description when nothing is present', () => {
    const bare: OfferJson = {
      ...makeOffer({}, '1'),
      attributes: {
        offer_id: null,
        title: null,
        street: null,
        house_number: null,
        postcode: null,
        city: null,
        show_address: true,
        latitude: null,
        longitude: null,
        buy_price: null,
        living_space: null,
        plot_area: null,
        number_of_rooms: null,
        description_note: null,
        location_note: null,
        furnishing_note: null,
        other_note: null,
        updated_at: null,
      },
      relationships: {},
    }
    const a = mapOffer(bare, new Map(), 'bima')
    expect(a.caseNumber).toBe('')
    expect(a.address).toBeNull()
    expect(a.title).toBeNull()
    expect(a.photoUrls).toEqual([])
    expect(a.photoCount).toBe(0)
    expect(a.thumbnailUrl).toBeNull()
    expect(a.attachments).toEqual([])
    expect(a.description).toBeNull()
    expect(a.sourceLivingAreaSqm).toBeNull()
    expect(a.sourceLandAreaSqm).toBeNull()
    expect(a.sourceRooms).toBeNull()
    expect(a.lat).toBeNull()
    expect(a.lng).toBeNull()
  })
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function searchPage(offers: OfferJson[], total: number, offset: number): SearchResponse {
  return { data: offers, included: INCLUDED, meta: { offset: String(offset), total } }
}

describe('fetchAllListings', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns everything from a single page when meta.total fits it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(searchPage([makeOffer({}, '1'), makeOffer({}, '2')], 2, 0))),
    )
    const { auctions, total } = await fetchAllListings('bima')
    expect(total).toBe(2)
    expect(auctions.map((a) => a.externalId)).toEqual(['1', '2'])
  })

  it('keeps paging via offset until meta.total is exhausted', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(searchPage([makeOffer({}, '1')], 2, 0)))
      .mockResolvedValueOnce(jsonResponse(searchPage([makeOffer({}, '2')], 2, 1)))
    vi.stubGlobal('fetch', fetchMock)

    const { auctions, total } = await fetchAllListings('bima')
    expect(total).toBe(2)
    expect(auctions.map((a) => a.externalId)).toEqual(['1', '2'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondUrl = fetchMock.mock.calls[1]![0] as string
    expect(secondUrl).toContain('offset=1')
    expect(secondUrl).toContain('filters%5Bcategory%5D=living')
    expect(secondUrl).toContain('filters%5Bcommercialization_type%5D=BUY')
  })

  it('stops when the API returns an empty page even though meta.total says more', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(searchPage([], 5, 0))))
    const { auctions, total } = await fetchAllListings('bima')
    expect(auctions).toEqual([])
    expect(total).toBe(5)
  })
})
