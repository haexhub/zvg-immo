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

  it('treats a short dot fraction as a decimal point', () => {
    expect(parseAreaValue('2.5 m²')).toBe(2.5)
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

  it('finds a plain m² value after the Grundstück label', () => {
    expect(findLandAreaSqm('Grundstück 450 m²')).toBe(450)
  })

  it('finds a hectare value after the Grundstück label', () => {
    expect(findLandAreaSqm('Grundstück 2 ha')).toBe(20000)
  })

  it('does not read "1 Haus" as one hectare', () => {
    expect(findLandAreaSqm('Grundstück mit 1 Haus und Garten')).toBeNull()
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

  it('finds a plain room count', () => {
    expect(findRooms('3 Zimmer')).toBe(3)
  })

  it('does not count room-name compounds', () => {
    expect(findRooms('Wohnzimmer, 2 Schlafzimmer, Küche, Bad')).toBeNull()
  })
})

describe('findLivingAreaSqm — multilingual', () => {
  it('finds Czech podlahová plocha', () => {
    expect(findLivingAreaSqm('podlahová plocha 65 m²')).toBe(65)
  })
  it('finds Czech užitná plocha', () => {
    expect(findLivingAreaSqm('užitná plocha: 78 m²')).toBe(78)
  })
  it('finds Polish powierzchnia użytkowa', () => {
    expect(findLivingAreaSqm('powierzchnia użytkowa 56 m²')).toBe(56)
  })
  it('finds Bosnian stambena površina', () => {
    expect(findLivingAreaSqm('stambena površina 48 m²')).toBe(48)
  })
  it('finds Hungarian alapterület', () => {
    expect(findLivingAreaSqm('alapterület: 92 m²')).toBe(92)
  })
  it('finds Lithuanian gyvenamasis plotas', () => {
    expect(findLivingAreaSqm('gyvenamasis plotas 110 m²')).toBe(110)
  })
  it('finds Spanish superficie construida', () => {
    expect(findLivingAreaSqm('superficie construida 85 m²')).toBe(85)
  })
  it('finds Italian superficie utile', () => {
    expect(findLivingAreaSqm('superficie utile 72 m²')).toBe(72)
  })
  it('finds French surface habitable', () => {
    expect(findLivingAreaSqm('surface habitable 95 m²')).toBe(95)
  })
  it('finds Dutch woonoppervlakte', () => {
    expect(findLivingAreaSqm('woonoppervlakte 60 m²')).toBe(60)
  })
  it('finds Danish boligareal', () => {
    expect(findLivingAreaSqm('boligareal 105 m²')).toBe(105)
  })
  it('finds Finnish asuinpinta-ala', () => {
    expect(findLivingAreaSqm('asuinpinta-ala 88 m²')).toBe(88)
  })
  it('finds Icelandic flatarmál íbúðar', () => {
    expect(findLivingAreaSqm('flatarmál íbúðar 70 m²')).toBe(70)
  })
})

describe('findLandAreaSqm — multilingual', () => {
  it('finds Czech výměra pozemku', () => {
    expect(findLandAreaSqm('výměra pozemku: 450 m²')).toBe(450)
  })
  it('finds Czech výměra alone', () => {
    expect(findLandAreaSqm('výměra 820 m²')).toBe(820)
  })
  it('finds Polish powierzchnia działki', () => {
    expect(findLandAreaSqm('powierzchnia działki 1200 m²')).toBe(1200)
  })
  it('finds Bosnian površina parcele', () => {
    expect(findLandAreaSqm('površina parcele 600 m²')).toBe(600)
  })
  it('finds Hungarian telekterület', () => {
    expect(findLandAreaSqm('telekterület: 350 m²')).toBe(350)
  })
  it('finds Lithuanian sklypo plotas', () => {
    expect(findLandAreaSqm('sklypo plotas 2 ha')).toBe(20000)
  })
  it('does not read multilingual living label as land', () => {
    expect(findLandAreaSqm('alapterület: 92 m²')).toBeNull()
  })
  it('finds Spanish superficie del solar', () => {
    expect(findLandAreaSqm('superficie del solar 500 m²')).toBe(500)
  })
  it('finds Italian superficie del terreno', () => {
    expect(findLandAreaSqm('superficie del terreno 900 m²')).toBe(900)
  })
  it('finds French surface du terrain', () => {
    expect(findLandAreaSqm('surface du terrain 1100 m²')).toBe(1100)
  })
  it('finds Dutch perceelsoppervlakte', () => {
    expect(findLandAreaSqm('perceelsoppervlakte 400 m²')).toBe(400)
  })
  it('finds Danish grundareal', () => {
    expect(findLandAreaSqm('grundareal 700 m²')).toBe(700)
  })
  it('finds Finnish tontin pinta-ala', () => {
    expect(findLandAreaSqm('tontin pinta-ala 950 m²')).toBe(950)
  })
  it('finds Icelandic lóðarstærð', () => {
    expect(findLandAreaSqm('lóðarstærð 550 m²')).toBe(550)
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

  it('finds a plural unit count', () => {
    expect(findUnits('2 Wohneinheiten')).toBe(2)
  })

  it('does not read a unit number as a count', () => {
    expect(findUnits('Wohneinheit Nr. 5')).toBeNull()
  })
})
