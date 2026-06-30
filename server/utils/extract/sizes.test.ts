import { describe, expect, it } from 'vitest'
import {
  findLandAreaSqm,
  findLivingAreaSqm,
  findRooms,
  findUnits,
  parseAreaValue,
} from './sizes'

describe('parseAreaValue', () => {
  it('parses a plain m² value', () => {
    expect(parseAreaValue('140 m²')).toBe(140)
  })

  it('accepts the "m2" and "qm" unit spellings', () => {
    expect(parseAreaValue('140 m2')).toBe(140)
    expect(parseAreaValue('620 qm')).toBe(620)
  })

  it('parses German thousands + decimal grouping', () => {
    expect(parseAreaValue('1.234,56 m²')).toBe(1234.56)
    expect(parseAreaValue('1.500 m²')).toBe(1500)
  })

  it('ignores leading approximation words', () => {
    expect(parseAreaValue('ca. 620 m²')).toBe(620)
  })

  it('converts hectares to m²', () => {
    expect(parseAreaValue('2,5 ha')).toBe(25000)
  })

  it('returns null when no area unit is present', () => {
    expect(parseAreaValue('keine Angabe')).toBeNull()
  })

  it('does not mistake a Euro amount for an area', () => {
    expect(parseAreaValue('Verkehrswert 214.000,00 Euro')).toBeNull()
  })
})

describe('findLivingAreaSqm', () => {
  it('finds a labeled Wohnfläche', () => {
    expect(findLivingAreaSqm('Wohnfläche: 140 m²')).toBe(140)
  })

  it('handles approximation and decimals', () => {
    expect(findLivingAreaSqm('Wohnfläche ca. 140,5 m²')).toBe(140.5)
  })

  it('recognizes the Wfl. abbreviation', () => {
    expect(findLivingAreaSqm('Wfl. 98 m²')).toBe(98)
  })

  it('picks living area when both areas are present', () => {
    expect(
      findLivingAreaSqm('Grundstücksfläche 620 m², Wohnfläche 140 m²'),
    ).toBe(140)
  })

  it('returns null without a living-area label', () => {
    expect(findLivingAreaSqm('Grundstücksgröße 620 m²')).toBeNull()
  })
})

describe('findLandAreaSqm', () => {
  it('finds a labeled Grundstücksgröße', () => {
    expect(findLandAreaSqm('Grundstücksgröße: 620 m²')).toBe(620)
  })

  it('finds Grundstück with qm and thousands', () => {
    expect(findLandAreaSqm('Grundstück ca. 1.250 qm')).toBe(1250)
  })

  it('finds Grundstücksfläche', () => {
    expect(findLandAreaSqm('Grundstücksfläche 800 m²')).toBe(800)
  })

  it('returns null when only living area is present', () => {
    expect(findLandAreaSqm('Wohnfläche 140 m²')).toBeNull()
  })
})

describe('findRooms', () => {
  it('finds whole rooms', () => {
    expect(findRooms('5 Zimmer')).toBe(5)
  })

  it('finds half rooms', () => {
    expect(findRooms('4,5 Zi.')).toBe(4.5)
  })

  it('returns null without a room count', () => {
    expect(findRooms('Einfamilienhaus')).toBeNull()
  })
})

describe('findUnits', () => {
  it('finds Wohneinheiten', () => {
    expect(findUnits('3 Wohneinheiten')).toBe(3)
  })

  it('finds a labeled unit count', () => {
    expect(findUnits('Wohneinheiten: 2')).toBe(2)
  })

  it('returns null without a unit count', () => {
    expect(findUnits('Einfamilienhaus, 140 m²')).toBeNull()
  })
})
