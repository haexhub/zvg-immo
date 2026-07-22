import { describe, expect, it } from 'vitest'
import { mapPublication, type SiPublication } from './list'

function makePublication(overrides: Partial<SiPublication> = {}): SiPublication {
  return {
    id: '45545970-1f2e-4c51-9064-fcb1ffdcd915',
    caseNumber: 4493,
    caseYear: 2019,
    registerTypeRelation: { valueContent: 'I' },
    courtRelation: { valueContent: 'Okrajno sodišče v Ljubljani' },
    saleStartAt: '2026-11-26T10:30:00Z',
    saleEndAt: '2026-11-26T10:45:00Z',
    status: 'pending',
    description: null,
    propertyKindRelation: { valueCode: '03', valueContent: 'Posamezni del stavbe' },
    area: '13.50',
    roomsRelation: null,
    floorRelation: null,
    constructionYear: null,
    energyCertificateRelation: null,
    securityPrice: null,
    cadastralMunicipalityName: null,
    startingPrice: '12690',
    estimatedPrice: '12690',
    address: {
      street: 'Rakuševa ulica',
      houseNumber: '2',
      zip: '1000',
      city: 'Ljubljana',
      latitude: '46.076706',
      longitude: '14.483842',
    },
    pictureFileId: null,
    pictureFileIdRelation: null,
    ...overrides,
  }
}

describe('mapPublication', () => {
  it('maps area to living area for a building unit (kind 03)', () => {
    const a = mapPublication(makePublication(), 'si-sodnedrazbe')
    expect(a.sourceLivingAreaSqm).toBe(13.5)
    expect(a.sourceLandAreaSqm).toBeNull()
  })

  it('maps area to land area for a parcel (kind 01)', () => {
    const a = mapPublication(
      makePublication({
        propertyKindRelation: { valueCode: '01', valueContent: 'Zemljiška parcela' },
        area: '812',
      }),
      'si-sodnedrazbe',
    )
    expect(a.sourceLandAreaSqm).toBe(812)
    expect(a.sourceLivingAreaSqm).toBeNull()
  })

  it('leaves both areas null for a building right (kind 04) and missing kind', () => {
    const pravica = mapPublication(
      makePublication({ propertyKindRelation: { valueCode: '04', valueContent: 'Stavbna pravica' } }),
      'si-sodnedrazbe',
    )
    expect(pravica.sourceLivingAreaSqm).toBeNull()
    expect(pravica.sourceLandAreaSqm).toBeNull()

    const unknown = mapPublication(makePublication({ propertyKindRelation: null }), 'si-sodnedrazbe')
    expect(unknown.sourceLivingAreaSqm).toBeNull()
    expect(unknown.sourceLandAreaSqm).toBeNull()
  })

  it('takes rooms from roomsRelation when numeric', () => {
    const a = mapPublication(
      makePublication({ roomsRelation: { valueContent: '2-sobno' } }),
      'si-sodnedrazbe',
    )
    expect(a.sourceRooms).toBe(2)

    const studio = mapPublication(
      makePublication({ roomsRelation: { valueContent: 'Garsonjera' } }),
      'si-sodnedrazbe',
    )
    expect(studio.sourceRooms).toBeNull()
  })

  it('passes address coordinates through as numbers', () => {
    const a = mapPublication(makePublication(), 'si-sodnedrazbe')
    expect(a.lat).toBe(46.076706)
    expect(a.lng).toBe(14.483842)
  })

  it('builds a labeled description from floor, year, energy certificate and deposit', () => {
    const a = mapPublication(
      makePublication({
        description: 'Prodaja stanovanja.',
        floorRelation: { valueContent: '7. nadstropje' },
        constructionYear: 2009,
        energyCertificateRelation: { valueContent: 'Razred C: od 35 do 60 kWh/m2a' },
        securityPrice: '1269',
      }),
      'si-sodnedrazbe',
    )
    expect(a.description).toBe(
      'Prodaja stanovanja.\nEtage: 7. nadstropje · Baujahr: 2009 · Energieausweis: Razred C: od 35 do 60 kWh/m2a · Kaution: 1.269 €',
    )
  })

  it('leaves description null when neither description nor extras exist', () => {
    const a = mapPublication(makePublication(), 'si-sodnedrazbe')
    expect(a.description).toBeNull()
  })

  it('takes startingBid from startingPrice and sourceSecurityDeposit from securityPrice', () => {
    const a = mapPublication(
      makePublication({ startingPrice: '12690', securityPrice: '1269' }),
      'si-sodnedrazbe',
    )
    expect(a.startingBid).toBe(12690)
    expect(a.sourceSecurityDeposit).toBe(1269)
  })

  it('leaves startingBid and sourceSecurityDeposit null when the source has no values', () => {
    const a = mapPublication(
      makePublication({ startingPrice: null, securityPrice: null }),
      'si-sodnedrazbe',
    )
    expect(a.startingBid).toBeNull()
    expect(a.sourceSecurityDeposit).toBeNull()
  })
})
