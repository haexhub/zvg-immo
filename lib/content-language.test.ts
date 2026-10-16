import { describe, expect, it } from 'vitest'
import type { LocationContext } from '~/types/auction'
import { countryContentLanguage, isPassthroughLanguage, translatablePlaceNames } from './content-language'

describe('isPassthroughLanguage', () => {
  it('is a passthrough when the target matches the country primary language', () => {
    expect(isPassthroughLanguage('de', 'de')).toBe(true)
    expect(isPassthroughLanguage('at', 'de')).toBe(true)
    expect(isPassthroughLanguage('gb', 'en')).toBe(true)
    expect(isPassthroughLanguage('us', 'en')).toBe(true)
    expect(isPassthroughLanguage('ca', 'en')).toBe(true)
  })

  it('is not a passthrough when the target differs from the country primary language', () => {
    expect(isPassthroughLanguage('de', 'en')).toBe(false)
    expect(isPassthroughLanguage('gb', 'de')).toBe(false)
    expect(isPassthroughLanguage('es', 'de')).toBe(false)
    expect(isPassthroughLanguage('es', 'en')).toBe(false)
    expect(isPassthroughLanguage('bg', 'de')).toBe(false)
    expect(isPassthroughLanguage('bg', 'en')).toBe(false)
  })

  it('is case-insensitive on the country code', () => {
    expect(isPassthroughLanguage('DE', 'de')).toBe(true)
  })

  it('is not a passthrough for an unknown country', () => {
    expect(isPassthroughLanguage('zz', 'de')).toBe(false)
    expect(isPassthroughLanguage('zz', 'en')).toBe(false)
  })
})

describe('countryContentLanguage', () => {
  it('infers country source languages independently from supported UI locales', () => {
    expect(countryContentLanguage('bg')).toBe('bg')
    expect(countryContentLanguage('BG')).toBe('bg')
    expect(countryContentLanguage('at')).toBe('de')
    expect(countryContentLanguage('cz')).toBe('cs')
    expect(countryContentLanguage('dk')).toBe('da')
    expect(countryContentLanguage('gr')).toBe('el')
  })

  it('returns null for an unknown country so the LLM can detect it', () => {
    expect(countryContentLanguage('zz')).toBeNull()
    expect(countryContentLanguage('deu')).toBeNull()
  })
})

describe('translatablePlaceNames', () => {
  it('collects settlement, named industry-site and airport names once each', () => {
    const context = {
      nearbyPlaces: [{ name: 'Бургас' }, { name: 'с. Равна' }],
      environment: {
        heavyIndustrySites: [{ name: 'Лукойл' }, { name: null }, { name: 'Бургас' }],
        nearestAirportName: 'Летище Бургас',
      },
    } as unknown as LocationContext

    expect(translatablePlaceNames(context)).toEqual(['Бургас', 'с. Равна', 'Лукойл', 'Летище Бургас'])
    expect(translatablePlaceNames(null)).toEqual([])
  })
})
