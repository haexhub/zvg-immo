import { describe, expect, it } from 'vitest'
import { filterPlaces, placeSearchTerm } from './de-places'

describe('filterPlaces', () => {
  it('returns nothing for queries under 2 characters', () => {
    expect(filterPlaces('b')).toEqual([])
    expect(filterPlaces('')).toEqual([])
  })

  it('ranks prefix matches before substring matches', () => {
    const names = filterPlaces('ber', 20).map((r) => r.name)
    expect(names).toContain('Bermel')
    expect(names).toContain('Otterberg')
    // Otterberg only matches as a substring ("...berg"), not a prefix — every
    // "Ber…" prefix match must be ranked ahead of it.
    const otterbergIndex = names.indexOf('Otterberg')
    const prefixMatches = names.filter((n) => n.toLocaleLowerCase('de').startsWith('ber'))
    expect(prefixMatches.every((n) => names.indexOf(n) < otterbergIndex)).toBe(true)
  })

  it('is case- and diacritic-insensitive', () => {
    expect(filterPlaces('MÜNCHEN').map((r) => r.name)).toEqual(['München'])
    expect(filterPlaces('münchen').map((r) => r.name)).toEqual(['München'])
  })

  it('matches umlauts typed as plain ASCII (dropped or expanded)', () => {
    // A user on an ASCII keyboard either drops the umlaut or expands it.
    expect(filterPlaces('munchen').map((r) => r.name)).toEqual(['München'])
    expect(filterPlaces('muenchen').map((r) => r.name)).toEqual(['München'])
    expect(filterPlaces('koln').map((r) => r.name)).toEqual(['Köln'])
    expect(filterPlaces('wurzburg').map((r) => r.name)).toEqual(['Würzburg'])
  })

  it('caps results at the given limit', () => {
    expect(filterPlaces('er', 3)).toHaveLength(3)
  })

  it('returns [] when nothing matches', () => {
    expect(filterPlaces('xyzxyz')).toEqual([])
  })
})

describe('placeSearchTerm', () => {
  it('strips a parenthetical qualifier the auction address never contains', () => {
    expect(placeSearchTerm('Kempten (Allgäu)')).toBe('Kempten')
    expect(placeSearchTerm('Frankfurt (Oder)')).toBe('Frankfurt')
    expect(placeSearchTerm('Halle (Saale)')).toBe('Halle')
  })

  it('leaves a plain place name unchanged', () => {
    expect(placeSearchTerm('München')).toBe('München')
  })
})
