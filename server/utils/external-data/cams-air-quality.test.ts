import { describe, expect, it, vi } from 'vitest'
import { airQualityLevel, createCamsAirQualityEnhancer, readAirQuality } from './cams-air-quality'
import { buildLocationContext } from './osm-location-context'
import type { Auction } from '~/types/auction'

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'test',
    country: 'se',
    region: 'Blekinge',
    externalId: '42',
    caseNumber: 'F-42',
    authority: 'Kronofogden',
    title: 'Hus',
    address: 'Skyttevagen 6',
    marketValueEur: 52_000,
    marketValueText: '575000 SEK',
    auctionDateIso: null,
    auctionDateText: null,
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl: null,
    pdfUrlUpstream: null,
    detailUrlUpstream: null,
    attachments: [],
    description: null,
    photoCount: 0,
    thumbnailUrl: null,
    lat: 56.2786,
    lng: 14.5333,
    ...overrides,
  }
}

function context() {
  return buildLocationContext({ lat: 56.2786, lng: 14.5333 }, [], '2026-07-29T00:00:00.000Z')
}

function response(current: Record<string, unknown> | null): Response {
  return new Response(JSON.stringify({ current }), { status: 200 })
}

describe('airQualityLevel', () => {
  it.each([
    [0, 'good'],
    [20, 'good'],
    [21, 'fair'],
    [40, 'fair'],
    [55, 'moderate'],
    [75, 'poor'],
    [95, 'very_poor'],
    [140, 'extremely_poor'],
  ])('maps EAQI %i to %s', (index, expected) => {
    expect(airQualityLevel(index)).toBe(expected)
  })

  it('reports unknown without a value', () => {
    expect(airQualityLevel(null)).toBe('unknown')
  })
})

describe('readAirQuality', () => {
  it('requests the configured point and parses the current values', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({
      time: '2026-07-29T13:00',
      european_aqi: 24,
      pm10: 8.2,
      pm2_5: 5.2,
      nitrogen_dioxide: 0.8,
      ozone: 61,
    }))

    const observation = await readAirQuality({ lat: 56.2786, lng: 14.5333 }, {
      checkedAt: '2026-07-29T00:00:00.000Z',
      fetchImpl,
    })

    const url = new URL(fetchImpl.mock.calls[0]![0] as string)
    expect(url.searchParams.get('latitude')).toBe('56.27860')
    expect(url.searchParams.get('longitude')).toBe('14.53330')
    expect(url.searchParams.get('current')).toContain('european_aqi')
    expect(observation).toMatchObject({
      index: 24,
      level: 'fair',
      particulateMatter10: 8.2,
      particulateMatter25: 5.2,
      nitrogenDioxide: 0.8,
      ozone: 61,
      // Requested as UTC but reported without a zone, so it is stamped here.
      observedAt: '2026-07-29T13:00Z',
    })
    expect(new Date(observation!.observedAt!).toISOString()).toBe('2026-07-29T13:00:00.000Z')
  })

  it('keeps a zone the service already stated', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({ time: '2026-07-29T15:00+02:00', pm10: 12 }))

    const observation = await readAirQuality({ lat: 0, lng: 0 }, {
      checkedAt: '2026-07-29T00:00:00.000Z',
      fetchImpl,
    })

    expect(observation?.observedAt).toBe('2026-07-29T15:00+02:00')
  })

  it('returns null when the grid cell carries no values at all', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({
      time: '2026-07-29T13:00',
      european_aqi: null,
      pm10: null,
      pm2_5: null,
      nitrogen_dioxide: null,
      ozone: null,
    }))

    await expect(readAirQuality({ lat: 0, lng: 0 }, {
      checkedAt: '2026-07-29T00:00:00.000Z',
      fetchImpl,
    })).resolves.toBeNull()
  })

  it('keeps a partial reading rather than discarding it', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({ pm10: 12, european_aqi: null }))

    const observation = await readAirQuality({ lat: 0, lng: 0 }, {
      checkedAt: '2026-07-29T00:00:00.000Z',
      fetchImpl,
    })

    expect(observation).toMatchObject({ index: null, level: 'unknown', particulateMatter10: 12 })
  })

  it('throws on a service error so the enhancer wrapper can log and move on', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('nope', { status: 503 }))

    await expect(readAirQuality({ lat: 0, lng: 0 }, {
      checkedAt: '2026-07-29T00:00:00.000Z',
      fetchImpl,
    })).rejects.toThrow('air quality service returned 503')
  })
})

describe('createCamsAirQualityEnhancer', () => {
  it('attaches the observation to the environment context', async () => {
    const enhancer = createCamsAirQualityEnhancer({
      checkedAt: '2026-07-29T00:00:00.000Z',
      fetchImpl: vi.fn<typeof fetch>(async () => response({ european_aqi: 24, pm2_5: 5.2 })),
    })

    const enhanced = await enhancer.enhance(auction(), context())

    expect(enhanced.environment.airQuality).toMatchObject({ index: 24, level: 'fair' })
    expect(enhanced.source.label).toContain('Air Quality')
  })

  it('adds a risk signal only for the harmful bands', async () => {
    const poor = createCamsAirQualityEnhancer({
      checkedAt: '2026-07-29T00:00:00.000Z',
      fetchImpl: vi.fn<typeof fetch>(async () => response({ european_aqi: 85 })),
    })
    const moderate = createCamsAirQualityEnhancer({
      checkedAt: '2026-07-29T00:00:00.000Z',
      fetchImpl: vi.fn<typeof fetch>(async () => response({ european_aqi: 55 })),
    })

    const poorContext = await poor.enhance(auction(), context())
    const moderateContext = await moderate.enhance(auction(), context())

    expect(poorContext.environment.riskSignals).toContain('air_quality_very_poor')
    expect(moderateContext.environment.riskSignals.some((s) => s.startsWith('air_quality'))).toBe(false)
  })

  it('leaves the context untouched when the service has no reading', async () => {
    const enhancer = createCamsAirQualityEnhancer({
      checkedAt: '2026-07-29T00:00:00.000Z',
      fetchImpl: vi.fn<typeof fetch>(async () => response(null)),
    })
    const original = context()

    const enhanced = await enhancer.enhance(auction(), original)

    expect(enhanced.environment.airQuality).toBeNull()
    expect(enhanced.source.label).toBe(original.source.label)
  })

  it('stays unsupported without coordinates or a service url', () => {
    const configured = createCamsAirQualityEnhancer({ checkedAt: '2026-07-29T00:00:00.000Z' })
    const unconfigured = createCamsAirQualityEnhancer({ checkedAt: '2026-07-29T00:00:00.000Z', serviceUrl: '' })

    expect(configured.supports(auction(), context())).toBe(true)
    expect(configured.supports(auction({ lat: null, lng: null }), context())).toBe(false)
    expect(unconfigured.supports(auction(), context())).toBe(false)
  })
})
