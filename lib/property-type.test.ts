import { describe, expect, it } from 'vitest'
import { classifyPropertyType } from './property-type'

describe('classifyPropertyType — German (existing behavior)', () => {
  it('classifies Einfamilienhaus', () => {
    expect(classifyPropertyType('Einfamilienhaus').id).toBe('einfamilienhaus')
  })
  it('classifies a compound as the dominant type', () => {
    expect(classifyPropertyType('Einfamilienhaus, Garage').id).toBe('einfamilienhaus')
  })
  it('returns sonstiges for unrecognized text', () => {
    expect(classifyPropertyType('Sonstiges Objekt').id).toBe('sonstiges')
  })
  it('returns unbekannt for null', () => {
    expect(classifyPropertyType(null).id).toBe('unbekannt')
  })
})

describe('classifyPropertyType — Spanish', () => {
  it('classifies vivienda unifamiliar', () => {
    expect(classifyPropertyType('Vivienda unifamiliar en Madrid').id).toBe('einfamilienhaus')
  })
  it('classifies piso', () => {
    expect(classifyPropertyType('Piso en tercera planta').id).toBe('eigentumswohnung')
  })
  it('classifies garaje', () => {
    expect(classifyPropertyType('Plaza de garaje').id).toBe('garage-stellplatz')
  })
})

describe('classifyPropertyType — Italian', () => {
  it('classifies casa unifamiliare', () => {
    expect(classifyPropertyType('Casa unifamiliare con giardino').id).toBe('einfamilienhaus')
  })
  it('classifies appartamento', () => {
    expect(classifyPropertyType('Appartamento al secondo piano').id).toBe('eigentumswohnung')
  })
})

describe('classifyPropertyType — French', () => {
  it('classifies maison individuelle', () => {
    expect(classifyPropertyType('Maison individuelle avec jardin').id).toBe('einfamilienhaus')
  })
  it('classifies appartement', () => {
    expect(classifyPropertyType('Appartement au 3ème étage').id).toBe('eigentumswohnung')
  })
  it('classifies terrain à bâtir', () => {
    expect(classifyPropertyType('Terrain à bâtir de 500 m²').id).toBe('unbebaut')
  })
})

describe('classifyPropertyType — Dutch (Belgium)', () => {
  it('classifies eengezinswoning', () => {
    expect(classifyPropertyType('Eengezinswoning met tuin').id).toBe('einfamilienhaus')
  })
  it('classifies appartement', () => {
    expect(classifyPropertyType('Appartement met terras').id).toBe('eigentumswohnung')
  })
})

describe('classifyPropertyType — Hungarian, Lithuanian, Latvian, Estonian', () => {
  it('classifies családi ház (HU)', () => {
    expect(classifyPropertyType('Családi ház kertkapcsolattal').id).toBe('einfamilienhaus')
  })
  it('classifies lakás (HU)', () => {
    expect(classifyPropertyType('Lakás a 2. emeleten').id).toBe('eigentumswohnung')
  })
  it('classifies butas (LT)', () => {
    expect(classifyPropertyType('Butas name').id).toBe('eigentumswohnung')
  })
  it('classifies dzīvoklis (LV)', () => {
    expect(classifyPropertyType('Dzīvoklis pilsētas centrā').id).toBe('eigentumswohnung')
  })
  it('classifies korter (EE)', () => {
    expect(classifyPropertyType('Korter kesklinnas').id).toBe('eigentumswohnung')
  })
})

describe('classifyPropertyType — Swedish, Finnish, Danish, Icelandic', () => {
  it('classifies villa (SE)', () => {
    expect(classifyPropertyType('Villa med stor tomt').id).toBe('einfamilienhaus')
  })
  it('classifies omakotitalo (FI)', () => {
    expect(classifyPropertyType('Omakotitalo isolla tontilla').id).toBe('einfamilienhaus')
  })
  it('classifies ejerlejlighed (DK)', () => {
    expect(classifyPropertyType('Ejerlejlighed på 3. sal').id).toBe('eigentumswohnung')
  })
  it('classifies einbýlishús (IS)', () => {
    expect(classifyPropertyType('Einbýlishús með bílskúr').id).toBe('einfamilienhaus')
  })
})

describe('classifyPropertyType — Bosnian/Croatian/Serbian', () => {
  it('classifies kuća', () => {
    expect(classifyPropertyType('Porodična kuća sa dvorištem').id).toBe('einfamilienhaus')
  })
  it('classifies stan', () => {
    expect(classifyPropertyType('Stan u prizemlju').id).toBe('eigentumswohnung')
  })
  it('classifies poslovni prostor', () => {
    expect(classifyPropertyType('Poslovni prostor u centru').id).toBe('gewerbe')
  })
})

describe('classifyPropertyType — Greek', () => {
  it('classifies διαμέρισμα', () => {
    expect(classifyPropertyType('Διαμέρισμα 85 τ.μ. στον 2ο όροφο').id).toBe('eigentumswohnung')
  })
  it('classifies μονοκατοικία', () => {
    expect(classifyPropertyType('Μονοκατοικία με αυλή').id).toBe('einfamilienhaus')
  })
  it('classifies κατάστημα', () => {
    expect(classifyPropertyType('Κατάστημα 153.80 τ.μ. Δήμος Πηνειού σε πλειστηριασμό').id).toBe('gewerbe')
  })
  it('classifies οικόπεδο', () => {
    expect(classifyPropertyType('Οικόπεδο 500 τ.μ.').id).toBe('unbebaut')
  })
  // Uppercase Greek conventionally drops the tonos — the common casing on
  // auction portals. Plain /i matching can't bridge ί vs Ι, so these go
  // through the foldGreek normalization.
  it('classifies all-caps ΔΙΑΜΕΡΙΣΜΑ without tonos', () => {
    expect(classifyPropertyType('ΔΙΑΜΕΡΙΣΜΑ 88,17 Τ.Μ. ΣΤΟΝ 2Ο ΟΡΟΦΟ').id).toBe('eigentumswohnung')
  })
  it('classifies all-caps ΜΟΝΟΚΑΤΟΙΚΙΑ without tonos', () => {
    expect(classifyPropertyType('ΜΟΝΟΚΑΤΟΙΚΙΑ ΜΕ ΑΥΛΗ').id).toBe('einfamilienhaus')
  })
  it('classifies all-caps ΟΙΚΟΠΕΔΟ without tonos', () => {
    expect(classifyPropertyType('ΟΙΚΟΠΕΔΟ 500 Τ.Μ.').id).toBe('unbebaut')
  })
  it('handles the final sigma in all-caps ΚΤΙΡΙΟ ΜΙΚΤΗΣ ΧΡΗΣΗΣ', () => {
    expect(classifyPropertyType('ΚΤΙΡΙΟ ΜΙΚΤΗΣ ΧΡΗΣΗΣ').id).toBe('wohn-geschaefts')
  })
})
