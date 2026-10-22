import { describe, expect, it } from 'vitest'
import { CADASTRAL_PARCEL_SOURCES, cadastralParcelLayer, cadastralParcelSourceFor } from './cadastral-parcels'

describe('cadastralParcelSourceFor', () => {
  it('picks the Bundesland service for German auctions', () => {
    const source = cadastralParcelSourceFor('de', 'Sachsen')
    expect(source?.id).toBe('de-sn')
    expect(source?.minZoom).toBe(18.1)
    expect(cadastralParcelSourceFor('de', 'Schleswig-Holstein')?.id).toBe('de-sh')
  })

  it('uses the national service for France, Poland, Czechia and Spain', () => {
    expect(cadastralParcelSourceFor('fr', '')?.id).toBe('fr')
    expect(cadastralParcelSourceFor('pl', 'mazowieckie')?.id).toBe('pl')
    expect(cadastralParcelSourceFor('CZ', 'Praha')?.id).toBe('cz')
    expect(cadastralParcelSourceFor('es', 'Madrid')?.id).toBe('es')
  })

  it('offers no layer where no usable service exists', () => {
    expect(cadastralParcelSourceFor('de', '')).toBeNull()
    expect(cadastralParcelSourceFor('de', 'Unbekannt')).toBeNull()
    expect(cadastralParcelSourceFor('de', 'Niedersachsen')).toBeNull()
    expect(cadastralParcelSourceFor('at', 'Wien')).toBeNull()
    expect(cadastralParcelSourceFor('it', 'Molise')).toBeNull()
    expect(cadastralParcelSourceFor(undefined, undefined)).toBeNull()
  })
})

describe('CADASTRAL_PARCEL_SOURCES', () => {
  it.each(CADASTRAL_PARCEL_SOURCES.map((source) => [source.id, source] as const))('%s is a complete https WMS entry', (_id, source) => {
    expect(source.url).toMatch(/^https:\/\//)
    expect(source.layers).not.toBe('')
    expect(source.attribution).not.toBe('')
    expect(source.minZoom).toBeGreaterThan(0)
    expect(source.minZoom).toBeLessThan(20)
  })
})

describe('cadastralParcelLayer', () => {
  it('requests WMS 1.3.0 images without CORS mode, hidden below the service minimum zoom', () => {
    const source = cadastralParcelSourceFor('de', 'Nordrhein-Westfalen')!
    const layer = cadastralParcelLayer(source)
    const wms = layer.getSource()!

    expect(layer.getMinZoom()).toBe(source.minZoom)
    expect(wms.getParams()).toMatchObject({ LAYERS: 'adv_alkis_flurstuecke', VERSION: '1.3.0', TRANSPARENT: true })
    expect(wms.getUrl()).toBe(source.url)
    // OpenLayers keeps the constructor option on a private field; a set value
    // would switch the <img> requests to CORS mode and break hosts without it.
    expect((wms as unknown as { crossOrigin_?: unknown }).crossOrigin_ ?? null).toBeNull()
  })
})
