import { describe, expect, it } from 'vitest'
import { localizeVectorStyleLanguage, mapTilerSatelliteStyleUrl, mapTilerStreetsStyleUrl, type MapboxStyle } from './map-tiles'

describe('mapTilerStreetsStyleUrl / mapTilerSatelliteStyleUrl', () => {
  it('builds a style.json URL with the default style id when none is configured', () => {
    expect(mapTilerStreetsStyleUrl('key123')).toBe('https://api.maptiler.com/maps/basic-v2/style.json?key=key123')
    expect(mapTilerSatelliteStyleUrl('key123')).toBe('https://api.maptiler.com/maps/hybrid/style.json?key=key123')
  })

  it('uses a configured style id over the default', () => {
    expect(mapTilerStreetsStyleUrl('key123', 'custom-streets')).toBe('https://api.maptiler.com/maps/custom-streets/style.json?key=key123')
  })

  it('falls back to the default for a blank configured style id', () => {
    expect(mapTilerStreetsStyleUrl('key123', '  ')).toBe('https://api.maptiler.com/maps/basic-v2/style.json?key=key123')
  })
})

describe('localizeVectorStyleLanguage', () => {
  function style(layers: MapboxStyle['layers']): MapboxStyle {
    return { version: 8, sources: {}, layers }
  }

  it('rewrites a place-label layer to prefer the target language, falling back to native name', () => {
    const result = localizeVectorStyleLanguage(style([
      { id: 'place-city', type: 'symbol', layout: { 'text-field': ['get', 'name'] } },
    ]), 'en')
    expect(result.layers![0]!.layout!['text-field']).toEqual(['coalesce', ['get', 'name:en'], ['get', 'name']])
  })

  it('rewrites a layer that already coalesces different name fields', () => {
    const result = localizeVectorStyleLanguage(style([
      { id: 'place-town', type: 'symbol', layout: { 'text-field': ['coalesce', ['get', 'name:de'], ['get', 'name']] } },
    ]), 'en')
    expect(result.layers![0]!.layout!['text-field']).toEqual(['coalesce', ['get', 'name:en'], ['get', 'name']])
  })

  it('rewrites a legacy string-template text-field (MapTiler streets-v2 Country/City/Continent labels)', () => {
    const result = localizeVectorStyleLanguage(style([
      { id: 'country-labels', type: 'symbol', layout: { 'text-field': '{name:en}' } },
    ]), 'de')
    expect(result.layers![0]!.layout!['text-field']).toEqual(['coalesce', ['get', 'name:de'], ['get', 'name']])
  })

  it('rewrites a bare "{name}" string-template text-field', () => {
    const result = localizeVectorStyleLanguage(style([
      { id: 'place-labels', type: 'symbol', layout: { 'text-field': '{name}' } },
    ]), 'de')
    expect(result.layers![0]!.layout!['text-field']).toEqual(['coalesce', ['get', 'name:de'], ['get', 'name']])
  })

  it('leaves an unrelated string-template text-field untouched', () => {
    const original = style([
      { id: 'housenumber', type: 'symbol', layout: { 'text-field': '{housenumber}' } },
    ])
    const result = localizeVectorStyleLanguage(original, 'de')
    expect(result.layers![0]!.layout!['text-field']).toBe('{housenumber}')
  })

  it('rewrites only the name-referencing stop in a legacy zoom-function text-field, leaving other stops intact', () => {
    const result = localizeVectorStyleLanguage(style([
      { id: 'airport', type: 'symbol', layout: { 'text-field': { stops: [[8, ' '], [9, '{iata}'], [12, '{name:en}']] } } },
    ]), 'de')
    expect(result.layers![0]!.layout!['text-field']).toEqual({
      stops: [
        [8, ' '],
        [9, '{iata}'],
        [12, ['coalesce', ['get', 'name:de'], ['get', 'name']]],
      ],
    })
  })

  it('leaves a zoom-function text-field with no name-referencing stop untouched', () => {
    const original = style([
      { id: 'highway-shield', type: 'symbol', layout: { 'text-field': { stops: [[8, '{ref}']] } } },
    ])
    const result = localizeVectorStyleLanguage(original, 'de')
    expect(result.layers![0]!.layout!['text-field']).toEqual({ stops: [[8, '{ref}']] })
  })

  it('leaves a layer whose text-field references an unrelated field untouched', () => {
    const original = style([
      { id: 'housenumber', type: 'symbol', layout: { 'text-field': ['get', 'housenumber'] } },
    ])
    const result = localizeVectorStyleLanguage(original, 'en')
    expect(result.layers![0]!.layout!['text-field']).toEqual(['get', 'housenumber'])
  })

  it('leaves a layer with no text-field untouched', () => {
    const result = localizeVectorStyleLanguage(style([
      { id: 'water', type: 'fill' },
    ]), 'en')
    expect(result.layers![0]).toEqual({ id: 'water', type: 'fill' })
  })

  it('does not mutate the input style', () => {
    const original = style([
      { id: 'place-city', type: 'symbol', layout: { 'text-field': ['get', 'name'] } },
    ])
    const snapshot = JSON.stringify(original)
    localizeVectorStyleLanguage(original, 'en')
    expect(JSON.stringify(original)).toBe(snapshot)
  })
})
