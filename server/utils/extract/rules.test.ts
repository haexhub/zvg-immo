import { describe, expect, it } from 'vitest'
import { extractByRules, findSecurityDepositEur } from './rules'

describe('extractByRules', () => {
  it('extracts type and both areas for a clearly described house', () => {
    const r = extractByRules({
      title: 'Einfamilienhaus',
      description: 'Wohnfläche 140 m², Grundstücksgröße 620 m²',
    })
    expect(r.propertyType).toBe('einfamilienhaus')
    expect(r.livingAreaSqm).toBe(140)
    expect(r.landAreaSqm).toBe(620)
  })

  it('extracts type, area and rooms for an Eigentumswohnung', () => {
    const r = extractByRules({
      title: 'Eigentumswohnung',
      description: 'Wohnfläche 98 m², 3 Zimmer',
    })
    expect(r.propertyType).toBe('eigentumswohnung')
    expect(r.livingAreaSqm).toBe(98)
    expect(r.landAreaSqm).toBeNull()
    expect(r.rooms).toBe(3)
  })

  it('classifies from the description when title is empty', () => {
    const r = extractByRules({
      title: null,
      description:
        'Verkauft wird ein Mehrfamilienhaus mit 3 Wohneinheiten, Wohnfläche 240 m²',
    })
    expect(r.propertyType).toBe('mehrfamilienhaus')
    expect(r.units).toBe(3)
    expect(r.livingAreaSqm).toBe(240)
  })

  it('prefers the title field over prose in the description', () => {
    const r = extractByRules({
      title: 'Eigentumswohnung',
      description:
        'Eigentumswohnung im 3. OG eines Mehrfamilienhauses, Wohnfläche 75 m²',
    })
    expect(r.propertyType).toBe('eigentumswohnung')
  })

  it('classifies a room-count title over a "Mehrfamilienhaus" mention in the description', () => {
    const r = extractByRules({
      title: '2-Zimmerwohnung Nr. 7, Zum Wiegele 20, 74865 Neckarzimmern',
      description:
        'Sondereigentum an der Wohnung im Dachgeschoss links, Wohnfläche ca. 68 m², in einem Mehrfamilienhaus.',
    })
    expect(r.propertyType).toBe('eigentumswohnung')
  })

  it('classifies "Wohn- und Geschäftshaus"', () => {
    const r = extractByRules({ title: 'Wohn- und Geschäftshaus', description: null })
    expect(r.propertyType).toBe('wohn-geschaefts')
  })

  it('classifies garage compounds and plurals', () => {
    expect(
      extractByRules({ title: 'Tiefgaragenstellplatz', description: null }).propertyType,
    ).toBe('garage-stellplatz')
    expect(
      extractByRules({ title: 'Doppelgarage', description: null }).propertyType,
    ).toBe('garage-stellplatz')
    expect(
      extractByRules({ title: '2 Garagen', description: null }).propertyType,
    ).toBe('garage-stellplatz')
  })

  it('converts agricultural hectares to m²', () => {
    const r = extractByRules({
      title: 'Ackerland',
      description: 'Grundstücksfläche 2,5 ha',
    })
    expect(r.propertyType).toBe('land-forst')
    expect(r.landAreaSqm).toBe(25000)
  })

  it('finds no area when the type is known but none is stated', () => {
    const r = extractByRules({ title: 'Einfamilienhaus', description: null })
    expect(r.propertyType).toBe('einfamilienhaus')
    expect(r.livingAreaSqm).toBeNull()
    expect(r.landAreaSqm).toBeNull()
  })

  it('returns a null type for empty input', () => {
    const r = extractByRules({ title: null, description: null })
    expect(r.propertyType).toBeNull()
  })

  it('extracts areas from Swedish Kronofogden Markarealen prose', () => {
    const r = extractByRules({
      title: 'Småhusenhet, bebyggd',
      description:
        'Värderingsobjektet är bebyggd med ett friliggande hus i två plan. ' +
        'Boarean uppgår till 180 m², fördelat på två lägenheter. ' +
        'Markarealen uppgår till 1 316 m², vars obebyggda delar utgörs av gräsmatta, träd och buskar.',
    })
    expect(r.propertyType).toBe('einfamilienhaus')
    expect(r.livingAreaSqm).toBe(180)
    expect(r.landAreaSqm).toBe(1316)
  })
})

describe('extractByRules — unlabeled area fallback', () => {
  it('assigns a bare title area to living space for a flat', () => {
    const r = extractByRules({ title: 'Stanovanje 13,50 m2', description: null })
    expect(r.livingAreaSqm).toBe(13.5)
    expect(r.landAreaSqm).toBeNull()
  })
  it('assigns a bare title area to land for farmland', () => {
    const r = extractByRules({ title: 'Land- und Forstwirtschaft 2,5 ha', description: null })
    expect(r.landAreaSqm).toBe(25000)
    expect(r.livingAreaSqm).toBeNull()
  })
  it('leaves ambiguous types unassigned', () => {
    const r = extractByRules({ title: 'Garage 18 m²', description: null })
    expect(r.livingAreaSqm).toBeNull()
    expect(r.landAreaSqm).toBeNull()
  })
  it('does not bucket a bare house area (could be the plot size)', () => {
    const r = extractByRules({ title: 'Einfamilienhaus, 850 m²', description: null })
    expect(r.livingAreaSqm).toBeNull()
    expect(r.landAreaSqm).toBeNull()
  })
  it('prefers the labeled area over the bare fallback', () => {
    const r = extractByRules({
      title: 'Einfamilienhaus 200 m²',
      description: 'Wohnfläche: 120 m², Grundstück 500 m²',
    })
    expect(r.livingAreaSqm).toBe(120)
    expect(r.landAreaSqm).toBe(500)
  })
})

describe('findSecurityDepositEur', () => {
  it('extracts an explicit amount stated next to the label', () => {
    expect(findSecurityDepositEur('Die Sicherheitsleistung beträgt 5.000,00 EUR.')).toBe(5000)
    expect(findSecurityDepositEur('Abweichend wird eine Sicherheitsleistung von 3000 € festgesetzt.')).toBe(3000)
  })

  it('ignores payment-routing boilerplate without a stated amount', () => {
    const text =
      'Kontoverbindung Sicherheitsleistung: ZZJ Hamm IBAN: DE08 3005 0000 0001 4748 16 ' +
      'LB Hessen-Thüringen, Verwendungszweck: AG Duisburg, Geschäftszeichen, Sicherheit, Datum der Versteigerung'
    expect(findSecurityDepositEur(text)).toBeNull()
  })

  it('returns null when the label is absent', () => {
    expect(findSecurityDepositEur('Verkehrswert 14.800,00 €')).toBeNull()
  })
})
