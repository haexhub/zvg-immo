import { describe, expect, it } from 'vitest'
import { bundeslandFromRegion, calculateAuctionCosts, GRUNDERWERBSTEUER_SATZ, volleGebuehr } from './auction-costs'

describe('calculateAuctionCosts — Sachsen example', () => {
  // Bargebot 200.000 € liegt exakt auf einer Tabellenstufe (bis 200.000 € → 2038,00 €),
  // damit sind die erwarteten Werte von Hand nachrechenbar ohne Rundungsunschärfe.
  const result = calculateAuctionCosts({
    bargebot: 200_000,
    bundesland: 'Sachsen',
    tageBisZahlung: 30,
  })

  it('applies the correct Grunderwerbsteuer rate for the given Bundesland', () => {
    expect(GRUNDERWERBSTEUER_SATZ['Sachsen']).toBeCloseTo(0.055, 5)
    expect(result.grunderwerbsteuerEur).toBeCloseTo(200_000 * 0.055, 2) // 11.000,00 €
  })

  it('computes Gerichtskosten as 0,5 Gebühr on the Bargebot', () => {
    expect(result.gerichtskostenZuschlagEur).toBeCloseTo(0.5 * 2038.0, 2) // 1.019,00 €
  })

  it('computes Grundbuchkosten as 1,0 Gebühr on the Bargebot', () => {
    expect(result.grundbuchkostenEur).toBeCloseTo(2038.0, 2)
  })

  it('computes Zinsen at 4% p.a. for the given number of days', () => {
    const expected = (200_000 * 0.04 * 30) / 365
    expect(result.zinsenEur).toBeCloseTo(expected, 2) // ≈ 657,53 €
  })

  it('always reports zero Maklerprovision and Notarkosten', () => {
    expect(result.maklerprovisionEur).toBe(0)
    expect(result.notarkostenEur).toBe(0)
    const makler = result.items.find((i) => i.label === 'Maklerprovision')
    const notar = result.items.find((i) => i.label === 'Notarkosten')
    expect(makler?.amountEur).toBe(0)
    expect(notar?.amountEur).toBe(0)
    expect(makler?.note).toMatch(/entfällt/)
    expect(notar?.note).toMatch(/entfällt/)
  })

  it('sums line items into an internally consistent grand total', () => {
    const sumOfItems = result.items.reduce((sum, i) => sum + i.amountEur, 0)
    expect(result.nebenkostenGesamtEur).toBeCloseTo(sumOfItems, 2)
    expect(result.gesamtkostenEur).toBeCloseTo(200_000 + result.nebenkostenGesamtEur, 2)
  })
})

describe('calculateAuctionCosts — Bundesland rate selection', () => {
  it('picks Bayern (lowest rate, 3.5%)', () => {
    const r = calculateAuctionCosts({ bargebot: 100_000, bundesland: 'Bayern', tageBisZahlung: 0 })
    expect(r.grunderwerbsteuerSatz).toBeCloseTo(0.035, 5)
    expect(r.grunderwerbsteuerEur).toBeCloseTo(3_500, 2)
  })

  it('picks Nordrhein-Westfalen (highest rate, 6.5%)', () => {
    const r = calculateAuctionCosts({ bargebot: 100_000, bundesland: 'Nordrhein-Westfalen', tageBisZahlung: 0 })
    expect(r.grunderwerbsteuerSatz).toBeCloseTo(0.065, 5)
    expect(r.grunderwerbsteuerEur).toBeCloseTo(6_500, 2)
  })

  it('zero days until payment means zero Zinsen', () => {
    const r = calculateAuctionCosts({ bargebot: 100_000, bundesland: 'Bayern', tageBisZahlung: 0 })
    expect(r.zinsenEur).toBe(0)
  })
})

describe('volleGebuehr — Gebührentabelle lookup', () => {
  it('matches known table brackets exactly', () => {
    expect(volleGebuehr(500)).toBeCloseTo(40.0, 2)
    expect(volleGebuehr(10_000)).toBeCloseTo(283.0, 2)
    expect(volleGebuehr(500_000)).toBeCloseTo(4_138.0, 2)
  })

  it('rounds up to the next bracket for values between steps', () => {
    // 12.000 liegt zwischen der 10.000er (283,00 €) und der 13.000er Stufe (313,50 €).
    expect(volleGebuehr(12_000)).toBeCloseTo(313.5, 2)
  })

  it('extrapolates above the tabulated range instead of throwing', () => {
    const gebuehr = volleGebuehr(600_000)
    expect(gebuehr).toBeGreaterThan(4_138.0)
  })
})

describe('bundeslandFromRegion', () => {
  it('recognizes an exact Bundesland name as set by the DE crawlers', () => {
    expect(bundeslandFromRegion('Sachsen')).toBe('Sachsen')
    expect(bundeslandFromRegion('Mecklenburg-Vorpommern')).toBe('Mecklenburg-Vorpommern')
  })

  it('returns null for unrecognized or missing region strings', () => {
    expect(bundeslandFromRegion('Madrid')).toBeNull()
    expect(bundeslandFromRegion('')).toBeNull()
    expect(bundeslandFromRegion(null)).toBeNull()
    expect(bundeslandFromRegion(undefined)).toBeNull()
  })
})
