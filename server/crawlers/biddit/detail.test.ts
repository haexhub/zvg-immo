import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchDetail, formatPropertyFacts, type DetailProperty } from './detail'
import { applyDetail } from './index'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stubDetail(body: unknown, status = 200): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(body, status)))
}

/** Shape mirrors the live BFF payload (verified against lots 297579/297841/297652). */
function detailFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lotId: 'l_1',
    referenceCode: '297841',
    estimatedPrice: 1.0,
    startingPrice: 200000.0,
    biddingEndDateTime: '2026-08-01T12:00:00.000Z',
    publicSaleStatus: 'CURRENT',
    withdrawn: false,
    attachments: [],
    properties: [
      {
        propertyId: 'p_1',
        title: { nl: 'Woning te Aalst' },
        description: { nl: 'Ruime woning met tuin.' },
        address: {
          street: { nl: 'Klakbaan' },
          estateNumber: '19',
          postalCode: '9320',
          municipality: { nl: 'Aalst' },
        },
        geoLocation: { lat: 50.9986968, lng: 4.1486567 },
        rooms: { numberOfBedrooms: 4, livingSurfaceArea: 297.0 },
        features: { terrainSurface: 888.0 },
        construction: { constructionYear: 1968 },
        utilities: { energeticClassRF: 'CLASS_E', pebScore: 405 },
        floodZone: { floodZoneType: null },
        destination: { isInvestmentProperty: false },
        pictures: [
          {
            pictureId: 'pp_a',
            orderIndex: 1,
            name: 'a.jpg',
            small: 'https://www.biddit.be/stg/s/pp_a.jpeg',
            medium: 'https://www.biddit.be/stg/m/pp_a.jpeg',
            large: 'https://www.biddit.be/stg/l/pp_a.jpeg',
          },
          {
            pictureId: 'pp_b',
            orderIndex: 0,
            name: 'b.jpg',
            small: 'https://www.biddit.be/stg/s/pp_b.jpeg',
            medium: 'https://www.biddit.be/stg/m/pp_b.jpeg',
            large: 'https://www.biddit.be/stg/l/pp_b.jpeg',
          },
        ],
        attachments: [],
      },
    ],
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('formatPropertyFacts', () => {
  it('renders year, bedrooms and EPC as a compact line', () => {
    const p = detailFixture().properties as DetailProperty[]
    expect(formatPropertyFacts(p[0]!)).toBe(
      'Baujahr: 1968 · Schlafzimmer: 4 · Energieklasse: E (405 kWh/m²·Jahr)',
    )
  })

  it('renders the EPC class without score when pebScore is absent', () => {
    const p: DetailProperty = {
      propertyId: 'p',
      utilities: { energeticClassRF: 'CLASS_F' },
    }
    expect(formatPropertyFacts(p)).toBe('Energieklasse: F')
  })

  it('includes flood zone and investment flag only when set', () => {
    const p: DetailProperty = {
      propertyId: 'p',
      floodZone: { floodZoneType: 'EFFECTIVE_FLOOD_ZONE' },
      destination: { isInvestmentProperty: true },
    }
    expect(formatPropertyFacts(p)).toBe(
      'Überschwemmungsgebiet: EFFECTIVE_FLOOD_ZONE · Investmentobjekt',
    )
  })

  it('returns null when every fact is missing', () => {
    expect(formatPropertyFacts({ propertyId: 'p' })).toBeNull()
  })
})

describe('fetchDetail', () => {
  it('falls back to startingPrice when estimatedPrice is the 1.00 placeholder', async () => {
    stubDetail(detailFixture())
    const info = await fetchDetail('297841')
    expect(info?.estimatedPrice).toBe(200000)
    expect(info?.startingPrice).toBe(200000)
  })

  it('prefers a real appraisal over the startingPrice', async () => {
    stubDetail(detailFixture({ estimatedPrice: 250000.0 }))
    const info = await fetchDetail('297841')
    expect(info?.estimatedPrice).toBe(250000)
    expect(info?.startingPrice).toBe(200000)
  })

  it('reports both prices as null when neither is filled in', async () => {
    stubDetail(detailFixture({ estimatedPrice: 1.0, startingPrice: null }))
    const info = await fetchDetail('297841')
    expect(info?.estimatedPrice).toBeNull()
    expect(info?.startingPrice).toBeNull()
  })

  it('maps geoLocation and structured sizes from the first property', async () => {
    stubDetail(detailFixture())
    const info = await fetchDetail('297841')
    expect(info?.lat).toBe(50.9986968)
    expect(info?.lng).toBe(4.1486567)
    expect(info?.sourceLivingAreaSqm).toBe(297)
    expect(info?.sourceLandAreaSqm).toBe(888)
  })

  it('treats the 0/0 geoLocation sentinel as absent coordinates', async () => {
    const fixture = detailFixture()
    ;(fixture.properties as Record<string, unknown>[])[0]!.geoLocation = { lat: 0, lng: 0 }
    stubDetail(fixture)
    const info = await fetchDetail('297841')
    expect(info?.lat).toBeNull()
    expect(info?.lng).toBeNull()
  })

  it('appends the facts line to the description', async () => {
    stubDetail(detailFixture())
    const info = await fetchDetail('297841')
    expect(info?.description).toBe(
      'Ruime woning met tuin.\n\nBaujahr: 1968 · Schlafzimmer: 4 · Energieklasse: E (405 kWh/m²·Jahr)',
    )
  })

  it('collects descriptions and photos from every property, sizes from the first', async () => {
    const fixture = detailFixture()
    const first = (fixture.properties as Record<string, unknown>[])[0]!
    fixture.properties = [
      first,
      {
        propertyId: 'p_2',
        title: { fr: 'Garage attenant' },
        features: { terrainSurface: 55.0 },
        pictures: [
          {
            pictureId: 'pp_c',
            orderIndex: 0,
            name: 'c.jpg',
            large: 'https://www.biddit.be/stg/l/pp_c.jpeg',
          },
          // Duplicate of a first-property picture — must not appear twice.
          {
            pictureId: 'pp_a',
            orderIndex: 1,
            name: 'a.jpg',
            large: 'https://www.biddit.be/stg/l/pp_a.jpeg',
          },
        ],
      },
    ]
    stubDetail(fixture)
    const info = await fetchDetail('297841')
    expect(info?.description).toContain('Ruime woning met tuin.')
    expect(info?.description).toContain('Garage attenant')
    expect(info?.photoCount).toBe(3)
    const photoIds = info?.attachments.filter((a) => a.kind === 'photo').map((a) => a.fileId)
    expect(photoIds).toEqual(['pp_a', 'pp_b', 'pp_c'])
    // Sizes stay first-property-only.
    expect(info?.sourceLandAreaSqm).toBe(888)
    // Thumbnail is still the first property's cover photo (lowest orderIndex).
    expect(info?.thumbnailUrl).toBe('https://www.biddit.be/stg/m/pp_b.jpeg')
  })

  it('turns every picture into a photo attachment', async () => {
    stubDetail(detailFixture())
    const info = await fetchDetail('297841')
    const fotos = info?.attachments.filter((a) => a.kind === 'photo') ?? []
    expect(fotos).toHaveLength(2)
    expect(fotos.map((f) => f.proxyUrl)).toEqual([
      'https://www.biddit.be/stg/l/pp_a.jpeg',
      'https://www.biddit.be/stg/l/pp_b.jpeg',
    ])
    expect(info?.photoCount).toBe(2)
  })

  it('returns null for vanished lots (404)', async () => {
    stubDetail({}, 404)
    expect(await fetchDetail('999999')).toBeNull()
  })
})

describe('applyDetail', () => {
  function baseAuction() {
    return {
      marketValueEur: null as number | null,
      marketValueText: null as string | null,
      description: null as string | null,
      address: null as string | null,
      attachments: [],
      pdfUrl: null as string | null,
      pdfUrlUpstream: null as string | null,
      photoCount: 0,
      thumbnailUrl: null as string | null,
      cancelled: false,
    }
  }

  function baseInfo() {
    return {
      estimatedPrice: null as number | null,
      startingPrice: null as number | null,
      description: null,
      address: null,
      attachments: [],
      photoCount: 0,
      thumbnailUrl: null,
      pdfUrl: null,
      pdfUrlUpstream: null,
      cancelled: false,
      lat: null as number | null,
      lng: null as number | null,
      sourceLivingAreaSqm: null as number | null,
      sourceLandAreaSqm: null as number | null,
    }
  }

  it('labels the Mindestgebot fallback as such', () => {
    const auction = baseAuction()
    applyDetail(auction, { ...baseInfo(), estimatedPrice: 200000, startingPrice: 200000 })
    expect(auction.marketValueEur).toBe(200000)
    expect(auction.marketValueText).toBe('ab 200.000 € (Mindestgebot)')
  })

  it('renders a real appraisal without the Mindestgebot label', () => {
    const auction = baseAuction()
    applyDetail(auction, { ...baseInfo(), estimatedPrice: 250000, startingPrice: 200000 })
    expect(auction.marketValueText).toBe('250.000 €')
  })

  it('copies coordinates and structured sizes onto the auction', () => {
    const auction = baseAuction() as ReturnType<typeof baseAuction> & {
      lat?: number | null
      lng?: number | null
      sourceLivingAreaSqm?: number | null
      sourceLandAreaSqm?: number | null
    }
    applyDetail(auction, {
      ...baseInfo(),
      lat: 50.99,
      lng: 4.14,
      sourceLivingAreaSqm: 297,
      sourceLandAreaSqm: 888,
    })
    expect(auction.lat).toBe(50.99)
    expect(auction.lng).toBe(4.14)
    expect(auction.sourceLivingAreaSqm).toBe(297)
    expect(auction.sourceLandAreaSqm).toBe(888)
  })

  it('leaves coordinates untouched when the source has none', () => {
    const auction = baseAuction() as ReturnType<typeof baseAuction> & { lat?: number | null }
    applyDetail(auction, { ...baseInfo(), lat: 50.99, lng: null })
    expect(auction.lat).toBeUndefined()
  })
})
