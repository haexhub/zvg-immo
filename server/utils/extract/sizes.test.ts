import { describe, expect, it } from 'vitest'
import {
  findLandAreaSqm,
  findLivingAreaSqm,
  findRooms,
  findTotalLandAreaSqm,
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

  it('accepts the Greek "τ.μ." unit, with and without dots', () => {
    expect(parseAreaValue('153.80 τ.μ.')).toBe(153.8)
    expect(parseAreaValue('80 τμ')).toBe(80)
  })

  it('does not read "τμ" inside a Greek word as a unit', () => {
    expect(parseAreaValue('2 τμήματα')).toBeNull()
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

  it('prefers a total plot area before later usage sub-areas', () => {
    const text =
      'Grundstück bestehend aus einer Parzelle mit einer Fläche von ca. 18,1 ha, wovon ca. 14,6 ha auf ' +
      'produktiven Forstboden mit einem Holzvorrat von 2 280 m3sk entfallen, ca. 1,8 ha Grundstücksfläche, ' +
      'ca. 1,4 ha Weideland sowie ca. 0,5 ha sonstiges Land.'

    expect(findLandAreaSqm(text)).toBe(181000)
  })

  it('does not read "1 Haus" as one hectare', () => {
    expect(findLandAreaSqm('Grundstück mit 1 Haus und Garten')).toBeNull()
  })
})

describe('findTotalLandAreaSqm', () => {
  it('extracts the total area from Swedish farm prose', () => {
    const text =
      'Fastighet bestående av ett skifte med en areal om ca 18,1 ha, varav ca 14,6 ha avser produktiv skogsmark ' +
      'med ett virkesförråd om 2 280 m3sk, ca 1,8 ha tomtmark, ca 1,4 ha betesmark samt ca 0,5 ha övrig mark.'

    expect(findTotalLandAreaSqm(text)).toBe(181000)
  })

  it('extracts the total area from German translated parcel prose', () => {
    const text =
      'Grundstück bestehend aus einer Parzelle mit einer Fläche von ca. 18,1 ha, wovon ca. 14,6 ha auf ' +
      'produktiven Forstboden entfallen, ca. 1,8 ha Grundstücksfläche und ca. 1,4 ha Weideland.'

    expect(findTotalLandAreaSqm(text)).toBe(181000)
  })

  it('extracts total labels before later sub-areas', () => {
    expect(findTotalLandAreaSqm('Gesamtfläche Grundstück: ca. 18,1 ha, davon Waldfläche 14,6 ha.')).toBe(181000)
  })

  it('extracts English total property area', () => {
    expect(findTotalLandAreaSqm('Property consisting of one parcel with an area of approximately 18.1 ha, of which 14.6 ha is forest.')).toBe(181000)
  })

  it('extracts Romance-language total parcel prose', () => {
    expect(findTotalLandAreaSqm('Finca compuesta por una parcela con una superficie de 18,1 ha, de las cuales 14,6 ha son forestales.')).toBe(181000)
    expect(findTotalLandAreaSqm('Terrain comprenant une parcelle avec une surface de 18,1 ha, dont 14,6 ha de forêt.')).toBe(181000)
  })

  it('extracts Polish total parcel prose', () => {
    expect(findTotalLandAreaSqm('Nieruchomość składa się z działki o powierzchni 18,1 ha, z czego 14,6 ha stanowią lasy.')).toBe(181000)
  })

  it('ignores usage sub-areas when no total area is stated', () => {
    expect(findTotalLandAreaSqm('ca 1,8 ha tomtmark, ca 1,4 ha betesmark samt ca 0,5 ha övrig mark.')).toBeNull()
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
  it('finds Greek επιφάνεια κατοικίας with τ.μ.', () => {
    expect(findLivingAreaSqm('επιφάνεια κατοικίας 95 τ.μ.')).toBe(95)
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
  it('finds Greek εμβαδόν οικοπέδου with τ.μ.', () => {
    expect(findLandAreaSqm('εμβαδόν οικοπέδου: 500 τ.μ.')).toBe(500)
  })
  it('does not read Greek "τμήματα" after a label as an area', () => {
    expect(findLandAreaSqm('εμβαδόν οικοπέδου: 2 τμήματα')).toBeNull()
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

describe('parseAreaValue — locale formats and units', () => {
  it('parses Anglo thousands grouping', () => {
    expect(parseAreaValue('1,234 m²')).toBe(1234)
  })
  it('parses Anglo decimal with thousands', () => {
    expect(parseAreaValue('1,234.56 m²')).toBe(1234.56)
  })
  it('parses comma decimal', () => {
    expect(parseAreaValue('70,80 m2')).toBe(70.8)
  })
  it('parses German thousands with comma decimal', () => {
    expect(parseAreaValue('1.234,56 m²')).toBe(1234.56)
  })
  it('parses the Italian mq unit', () => {
    expect(parseAreaValue('153 mq')).toBe(153)
  })
  it('does not read mq inside a word', () => {
    expect(parseAreaValue('153 mqx')).toBeNull()
  })
  it('parses the Greek τ.μ. unit', () => {
    expect(parseAreaValue('153.80 τ.μ.')).toBe(153.8)
  })
  it('reads a lone comma before 3 digits as decimal for hectares', () => {
    // Cadastral comma-decimal ("2,575 ha" = 2.575 ha), not 2575 ha.
    expect(parseAreaValue('2,575 ha')).toBe(25750)
  })
  it('still reads short comma decimals for hectares', () => {
    expect(parseAreaValue('2,5 ha')).toBe(25000)
  })
})

describe('findRooms — multilingual', () => {
  it('finds Swedish rum', () => {
    expect(findRooms('6 rum, 175 kvm')).toBe(6)
  })
  it('does not match rum inside a word', () => {
    expect(findRooms('Centrum 6')).toBeNull()
  })
  it('finds Italian vani label-first', () => {
    expect(findRooms('vani 4,5')).toBe(4.5)
  })
  it('finds Polish pokoi', () => {
    expect(findRooms('mieszkanie, 3 pokoje')).toBe(3)
  })
  it('finds Estonian -toaline', () => {
    expect(findRooms('3-toaline korter')).toBe(3)
  })
  it('finds French pièces', () => {
    expect(findRooms('appartement de 4 pièces')).toBe(4)
  })
  it('does not read French document "pièces" as rooms', () => {
    expect(findRooms('voir les 3 pièces jointes')).toBeNull()
    expect(findRooms('les 2 pièces du dossier')).toBeNull()
    expect(findRooms('avec 1 pièce jointe')).toBeNull()
    expect(findRooms('4 pièces justificatives')).toBeNull()
  })
})

describe('parseAreaValue — space-grouped thousands', () => {
  it('parses Swedish space grouping', () => {
    expect(parseAreaValue('1 331 kvm')).toBe(1331)
  })
  it('parses space grouping with comma decimal', () => {
    expect(parseAreaValue('12 500,50 m²')).toBe(12500.5)
  })
  it('does not glue an enumeration into one number', () => {
    expect(parseAreaValue('Nr. 5, 175 m²')).toBe(175)
  })
})

describe('findLandAreaSqm — Tomtbeskrivning', () => {
  it('finds the plot size behind the Swedish label', () => {
    expect(findLandAreaSqm('Tomtbeskrivning: ca 1 331 kvm tomtmark')).toBe(1331)
  })
})
