import { describe, expect, it } from 'vitest'
import { classifyObjekt } from './objektart'

describe('classifyObjekt — German (existing behavior)', () => {
  it('classifies Einfamilienhaus', () => {
    expect(classifyObjekt('Einfamilienhaus').id).toBe('einfamilienhaus')
  })
  it('classifies a compound as the dominant type', () => {
    expect(classifyObjekt('Einfamilienhaus, Garage').id).toBe('einfamilienhaus')
  })
  it('returns sonstiges for unrecognized text', () => {
    expect(classifyObjekt('Sonstiges Objekt').id).toBe('sonstiges')
  })
  it('returns unbekannt for null', () => {
    expect(classifyObjekt(null).id).toBe('unbekannt')
  })
})

describe('classifyObjekt — Spanish', () => {
  it('classifies vivienda unifamiliar', () => {
    expect(classifyObjekt('Vivienda unifamiliar en Madrid').id).toBe('einfamilienhaus')
  })
  it('classifies piso', () => {
    expect(classifyObjekt('Piso en tercera planta').id).toBe('eigentumswohnung')
  })
  it('classifies garaje', () => {
    expect(classifyObjekt('Plaza de garaje').id).toBe('garage-stellplatz')
  })
})

describe('classifyObjekt — Italian', () => {
  it('classifies casa unifamiliare', () => {
    expect(classifyObjekt('Casa unifamiliare con giardino').id).toBe('einfamilienhaus')
  })
  it('classifies appartamento', () => {
    expect(classifyObjekt('Appartamento al secondo piano').id).toBe('eigentumswohnung')
  })
})

describe('classifyObjekt — French', () => {
  it('classifies maison individuelle', () => {
    expect(classifyObjekt('Maison individuelle avec jardin').id).toBe('einfamilienhaus')
  })
  it('classifies appartement', () => {
    expect(classifyObjekt('Appartement au 3ème étage').id).toBe('eigentumswohnung')
  })
  it('classifies terrain à bâtir', () => {
    expect(classifyObjekt('Terrain à bâtir de 500 m²').id).toBe('unbebaut')
  })
})

describe('classifyObjekt — Dutch (Belgium)', () => {
  it('classifies eengezinswoning', () => {
    expect(classifyObjekt('Eengezinswoning met tuin').id).toBe('einfamilienhaus')
  })
  it('classifies appartement', () => {
    expect(classifyObjekt('Appartement met terras').id).toBe('eigentumswohnung')
  })
})

describe('classifyObjekt — Hungarian, Lithuanian, Latvian, Estonian', () => {
  it('classifies családi ház (HU)', () => {
    expect(classifyObjekt('Családi ház kertkapcsolattal').id).toBe('einfamilienhaus')
  })
  it('classifies lakás (HU)', () => {
    expect(classifyObjekt('Lakás a 2. emeleten').id).toBe('eigentumswohnung')
  })
  it('classifies butas (LT)', () => {
    expect(classifyObjekt('Butas name').id).toBe('eigentumswohnung')
  })
  it('classifies dzīvoklis (LV)', () => {
    expect(classifyObjekt('Dzīvoklis pilsētas centrā').id).toBe('eigentumswohnung')
  })
  it('classifies korter (EE)', () => {
    expect(classifyObjekt('Korter kesklinnas').id).toBe('eigentumswohnung')
  })
})

describe('classifyObjekt — Swedish, Finnish, Danish, Icelandic', () => {
  it('classifies villa (SE)', () => {
    expect(classifyObjekt('Villa med stor tomt').id).toBe('einfamilienhaus')
  })
  it('classifies omakotitalo (FI)', () => {
    expect(classifyObjekt('Omakotitalo isolla tontilla').id).toBe('einfamilienhaus')
  })
  it('classifies ejerlejlighed (DK)', () => {
    expect(classifyObjekt('Ejerlejlighed på 3. sal').id).toBe('eigentumswohnung')
  })
  it('classifies einbýlishús (IS)', () => {
    expect(classifyObjekt('Einbýlishús með bílskúr').id).toBe('einfamilienhaus')
  })
})

describe('classifyObjekt — Bosnian/Croatian/Serbian', () => {
  it('classifies kuća', () => {
    expect(classifyObjekt('Porodična kuća sa dvorištem').id).toBe('einfamilienhaus')
  })
  it('classifies stan', () => {
    expect(classifyObjekt('Stan u prizemlju').id).toBe('eigentumswohnung')
  })
  it('classifies poslovni prostor', () => {
    expect(classifyObjekt('Poslovni prostor u centru').id).toBe('gewerbe')
  })
})

describe('classifyObjekt — Greek', () => {
  it('classifies διαμέρισμα', () => {
    expect(classifyObjekt('Διαμέρισμα 85 τ.μ. στον 2ο όροφο').id).toBe('eigentumswohnung')
  })
  it('classifies μονοκατοικία', () => {
    expect(classifyObjekt('Μονοκατοικία με αυλή').id).toBe('einfamilienhaus')
  })
  it('classifies κατάστημα', () => {
    expect(classifyObjekt('Κατάστημα 153.80 τ.μ. Δήμος Πηνειού σε πλειστηριασμό').id).toBe('gewerbe')
  })
  it('classifies οικόπεδο', () => {
    expect(classifyObjekt('Οικόπεδο 500 τ.μ.').id).toBe('unbebaut')
  })
  // Uppercase Greek conventionally drops the tonos — the common casing on
  // auction portals. Plain /i matching can't bridge ί vs Ι, so these go
  // through the foldGreek normalization.
  it('classifies all-caps ΔΙΑΜΕΡΙΣΜΑ without tonos', () => {
    expect(classifyObjekt('ΔΙΑΜΕΡΙΣΜΑ 88,17 Τ.Μ. ΣΤΟΝ 2Ο ΟΡΟΦΟ').id).toBe('eigentumswohnung')
  })
  it('classifies all-caps ΜΟΝΟΚΑΤΟΙΚΙΑ without tonos', () => {
    expect(classifyObjekt('ΜΟΝΟΚΑΤΟΙΚΙΑ ΜΕ ΑΥΛΗ').id).toBe('einfamilienhaus')
  })
  it('classifies all-caps ΟΙΚΟΠΕΔΟ without tonos', () => {
    expect(classifyObjekt('ΟΙΚΟΠΕΔΟ 500 Τ.Μ.').id).toBe('unbebaut')
  })
  it('handles the final sigma in all-caps ΚΤΙΡΙΟ ΜΙΚΤΗΣ ΧΡΗΣΗΣ', () => {
    expect(classifyObjekt('ΚΤΙΡΙΟ ΜΙΚΤΗΣ ΧΡΗΣΗΣ').id).toBe('wohn-geschaefts')
  })
})
