import { describe, expect, it } from 'vitest'
import { regionNameForKommun } from './constants'

describe('regionNameForKommun', () => {
  it.each([
    ['Krokoms kommun', 'Jämtland'],
    ['Falu kommun', 'Dalarna'],
    ['Region Gotland', 'Gotland'],
    ['Gotlands kommun', 'Gotland'],
    ['Stockholms stad', 'Stockholm'],
    ['Göteborgs Stad', 'Västra Götaland'],
  ])('maps %s to %s', (kommun, region) => {
    expect(regionNameForKommun(kommun)).toBe(region)
  })

  it('returns null for an unknown kommun', () => {
    expect(regionNameForKommun('Test kommun')).toBeNull()
  })
})
