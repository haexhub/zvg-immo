import { describe, expect, it } from 'vitest'
import { extractByRules } from './rules'

describe('extractByRules', () => {
  it('extracts type and both areas for a clearly described house', () => {
    const r = extractByRules({
      objekt: 'Einfamilienhaus',
      beschreibung: 'Wohnfläche 140 m², Grundstücksgröße 620 m²',
    })
    expect(r.propertyType).toBe('einfamilienhaus')
    expect(r.livingAreaSqm).toBe(140)
    expect(r.landAreaSqm).toBe(620)
    expect(r.confident).toBe(true)
  })

  it('is confident with a known type and a single area (Eigentumswohnung)', () => {
    const r = extractByRules({
      objekt: 'Eigentumswohnung',
      beschreibung: 'Wohnfläche 98 m², 3 Zimmer',
    })
    expect(r.propertyType).toBe('eigentumswohnung')
    expect(r.livingAreaSqm).toBe(98)
    expect(r.landAreaSqm).toBeNull()
    expect(r.rooms).toBe(3)
    expect(r.confident).toBe(true)
  })

  it('classifies from the description when objekt is empty', () => {
    const r = extractByRules({
      objekt: null,
      beschreibung:
        'Verkauft wird ein Mehrfamilienhaus mit 3 Wohneinheiten, Wohnfläche 240 m²',
    })
    expect(r.propertyType).toBe('mehrfamilienhaus')
    expect(r.units).toBe(3)
    expect(r.livingAreaSqm).toBe(240)
    expect(r.confident).toBe(true)
  })

  it('prefers the objekt field over prose in the description', () => {
    const r = extractByRules({
      objekt: 'Eigentumswohnung',
      beschreibung:
        'Eigentumswohnung im 3. OG eines Mehrfamilienhauses, Wohnfläche 75 m²',
    })
    expect(r.propertyType).toBe('eigentumswohnung')
  })

  it('classifies "Wohn- und Geschäftshaus"', () => {
    const r = extractByRules({ objekt: 'Wohn- und Geschäftshaus', beschreibung: null })
    expect(r.propertyType).toBe('wohn-geschaefts')
  })

  it('classifies garage compounds and plurals', () => {
    expect(
      extractByRules({ objekt: 'Tiefgaragenstellplatz', beschreibung: null }).propertyType,
    ).toBe('garage-stellplatz')
    expect(
      extractByRules({ objekt: 'Doppelgarage', beschreibung: null }).propertyType,
    ).toBe('garage-stellplatz')
    expect(
      extractByRules({ objekt: '2 Garagen', beschreibung: null }).propertyType,
    ).toBe('garage-stellplatz')
  })

  it('converts agricultural hectares to m²', () => {
    const r = extractByRules({
      objekt: 'Ackerland',
      beschreibung: 'Grundstücksfläche 2,5 ha',
    })
    expect(r.propertyType).toBe('land-forst')
    expect(r.landAreaSqm).toBe(25000)
    expect(r.confident).toBe(true)
  })

  it('is not confident when the type is known but no area is found', () => {
    const r = extractByRules({ objekt: 'Einfamilienhaus', beschreibung: null })
    expect(r.propertyType).toBe('einfamilienhaus')
    expect(r.livingAreaSqm).toBeNull()
    expect(r.landAreaSqm).toBeNull()
    expect(r.confident).toBe(false)
  })

  it('returns null type and not-confident for empty input', () => {
    const r = extractByRules({ objekt: null, beschreibung: null })
    expect(r.propertyType).toBeNull()
    expect(r.confident).toBe(false)
  })
})

describe('extractByRules — unlabeled area fallback', () => {
  it('assigns a bare objekt area to living space for a flat', () => {
    const r = extractByRules({ objekt: 'Stanovanje 13,50 m2', beschreibung: null })
    expect(r.livingAreaSqm).toBe(13.5)
    expect(r.landAreaSqm).toBeNull()
  })
  it('assigns a bare objekt area to land for farmland', () => {
    const r = extractByRules({ objekt: 'Land- und Forstwirtschaft 2,5 ha', beschreibung: null })
    expect(r.landAreaSqm).toBe(25000)
    expect(r.livingAreaSqm).toBeNull()
  })
  it('leaves ambiguous types unassigned', () => {
    const r = extractByRules({ objekt: 'Garage 18 m²', beschreibung: null })
    expect(r.livingAreaSqm).toBeNull()
    expect(r.landAreaSqm).toBeNull()
  })
  it('does not bucket a bare house area (could be the plot size)', () => {
    const r = extractByRules({ objekt: 'Einfamilienhaus, 850 m²', beschreibung: null })
    expect(r.livingAreaSqm).toBeNull()
    expect(r.landAreaSqm).toBeNull()
    expect(r.confident).toBe(false)
  })
  it('prefers the labeled area over the bare fallback', () => {
    const r = extractByRules({
      objekt: 'Einfamilienhaus 200 m²',
      beschreibung: 'Wohnfläche: 120 m², Grundstück 500 m²',
    })
    expect(r.livingAreaSqm).toBe(120)
    expect(r.landAreaSqm).toBe(500)
  })
})
