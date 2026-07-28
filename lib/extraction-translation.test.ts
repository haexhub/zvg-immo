import { describe, expect, it } from 'vitest'
import type { AuctionExtraction } from '~/types/auction'
import { applyTranslatedExtractionTexts, extractTranslatableExtractionTexts } from './extraction-translation'

function extraction(overrides: Partial<AuctionExtraction> = {}): AuctionExtraction {
  return {
    propertyType: 'einfamilienhaus',
    landAreaSqm: null,
    livingAreaSqm: null,
    rooms: null,
    units: null,
    source: 'llm',
    confidence: 'low',
    at: '2026-07-28T00:00:00.000Z',
    ...overrides,
  }
}

describe('extraction translation helpers', () => {
  it('extracts only visible structured free text', () => {
    expect(extractTranslatableExtractionTexts(extraction({
      renovationNotes: ' Visst underhållsbehov finna ',
      heating: ' Fjärrvärme ',
      insights: {
        defects: ['Äldre fastighet med äldre ytlager', ''],
        encumbrances: [],
        landValueEurPerSqm: 123,
        construction: 'Källargrund',
        locationCharacter: null,
        summary: null,
      },
      planningNotes: {
        monumentProtection: 'Ingen information',
        contamination: null,
        developmentPlan: null,
        landConsolidation: null,
        developmentCharges: null,
        redevelopmentArea: null,
        conservationArea: null,
        landParcels: [{ label: 'Delområde A', areaSqm: 100, use: 'Villatomt' }],
      },
    }))).toEqual({
      biddingNotes: null,
      renovationNotes: 'Visst underhållsbehov finna',
      floor: null,
      heating: 'Fjärrvärme',
      insights: {
        defects: ['Äldre fastighet med äldre ytlager'],
        encumbrances: [],
        construction: 'Källargrund',
        locationCharacter: null,
        summary: null,
      },
      planningNotes: {
        monumentProtection: 'Ingen information',
        contamination: null,
        developmentPlan: null,
        landConsolidation: null,
        developmentCharges: null,
        redevelopmentArea: null,
        conservationArea: null,
        landParcels: [{ label: 'Delområde A', use: 'Villatomt' }],
      },
    })
  })

  it('merges translated text without changing numeric extraction data', () => {
    const original = extraction({
      livingAreaSqm: 88,
      renovationNotes: 'Visst underhållsbehov finna',
      heating: 'Fjärrvärme',
      insights: {
        defects: ['Äldre ytlager'],
        encumbrances: [],
        landValueEurPerSqm: 123,
        construction: 'Stomme av trä',
        locationCharacter: null,
        summary: null,
      },
    })

    expect(applyTranslatedExtractionTexts(original, {
      biddingNotes: null,
      renovationNotes: 'Gewisser Instandhaltungsbedarf vorhanden',
      floor: null,
      heating: 'Fernwärme',
      insights: {
        defects: ['Ältere Oberflächen'],
        encumbrances: [],
        construction: 'Holztragwerk',
        locationCharacter: null,
        summary: null,
      },
      planningNotes: null,
    })).toMatchObject({
      livingAreaSqm: 88,
      renovationNotes: 'Gewisser Instandhaltungsbedarf vorhanden',
      heating: 'Fernwärme',
      insights: {
        defects: ['Ältere Oberflächen'],
        landValueEurPerSqm: 123,
        construction: 'Holztragwerk',
      },
    })
  })
})
