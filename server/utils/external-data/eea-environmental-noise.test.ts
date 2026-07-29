import { describe, expect, it, vi } from 'vitest'
import type { Auction, LocationContext } from '~/types/auction'
import {
  applyEnvironmentalNoise,
  createEeaEnvironmentalNoiseEnhancer,
  readNoiseObservations,
} from './eea-environmental-noise'

function locationContext(overrides: Partial<LocationContext> = {}): LocationContext {
  return {
    nearbyPlaces: [],
    mobility: {
      publicTransportLevel: 'limited',
      nearestStopDistanceMeters: 800,
      stopCountWithin1000m: 1,
      stopCountWithin3000m: 3,
      nearestRailStationDistanceMeters: null,
      roadAccessLevel: 'regional',
      nearestMajorRoadDistanceMeters: 1200,
      majorRoadKinds: ['primary'],
      nearestFerryTerminalDistanceMeters: null,
      hasFerryRouteNearby: false,
      ferryAccessLikely: false,
    },
    amenities: [],
    environment: {
      industrialCountWithin1000m: 0,
      industrialCountWithin3000m: 0,
      commercialCountWithin1000m: 0,
      commercialCountWithin3000m: 0,
      nearestIndustrialDistanceMeters: null,
      nearestCommercialDistanceMeters: null,
      nearestHeavyIndustryDistanceMeters: null,
      heavyIndustryKinds: [],
      noisyRoadLevel: 'low',
      aviationNoiseLevel: 'low',
      nearestMotorwayDistanceMeters: null,
      nearestPrimaryRoadDistanceMeters: 1200,
      nearestAirportDistanceMeters: null,
      nearestRunwayDistanceMeters: null,
      nearestHelipadDistanceMeters: null,
      riskSignals: [],
    },
    demographics: {
      youthSignal: 'low',
      employmentSignal: 'low',
      declineRisk: 'medium',
      universityDistanceMeters: null,
      schoolOrChildcareCountWithin3000m: 0,
      workplaceSignalCountWithin5000m: 0,
      reasons: [],
      caveats: ['demographic_proxy_only'],
    },
    mapFeatures: [],
    neighborhood: {
      settlementPattern: 'rural',
      buildingCountWithin500m: 8,
      buildingDensityPerSqKm: 10,
      amenityCountWithin1000m: 0,
      vacantOrRuinCountWithin500m: 0,
      notes: [],
    },
    quality: {
      score: 70,
      verdict: 'good',
      strengths: [],
      weaknesses: [],
      caveats: ['osm_heuristic'],
    },
    source: {
      id: 'openstreetmap-overpass',
      label: 'OpenStreetMap / Overpass',
      url: 'https://www.openstreetmap.org/copyright',
      licenseNote: 'OSM fixture',
    },
    checkedAt: '2026-07-29T00:00:00.000Z',
    ...overrides,
  }
}

function auction(): Auction {
  return {
    platform: 'test',
    country: 'de',
    region: 'Berlin',
    externalId: '42',
    caseNumber: 'K 42',
    authority: 'Amtsgericht',
    title: 'Haus',
    address: 'Berlin',
    marketValueEur: 300_000,
    marketValueText: '300.000 EUR',
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
    lat: 52.52,
    lng: 13.405,
  }
}

describe('readNoiseObservations', () => {
  it('samples EEA END ImageServer contours at the auction point', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      value: '5',
      properties: { Values: ['3', '5'] },
      catalogItems: {
        features: [{ attributes: { Name: 'DE_DF4_8_roadNoise_Lden_DE' } }],
      },
    }), { status: 200 }))

    const observations = await readNoiseObservations(
      { lat: 52.52, lng: 13.405 },
      [{
        source: 'road',
        indicator: 'lden',
        imageServerUrl: 'https://noise.example.test/NoiseContours_road_lden/ImageServer',
      }],
      {
        checkedAt: '2026-07-29T00:00:00.000Z',
        fetchImpl,
      },
    )

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const url = fetchImpl.mock.calls[0]?.[0]
    expect(String(url)).toContain('/NoiseContours_road_lden/ImageServer/identify?')
    expect(String(url)).toContain('geometryType=esriGeometryPoint')
    expect(decodeURIComponent(String(url))).toContain('"x":13.405')
    expect(decodeURIComponent(String(url))).toContain('"y":52.52')
    expect(observations).toEqual([expect.objectContaining({
      source: 'road',
      indicator: 'lden',
      level: 'high',
      bandLabel: '>=75 dB Lden',
      minDb: 75,
      maxDb: null,
      sourceLayerName: 'DE_DF4_8_roadNoise_Lden_DE',
    })])
  })

  it('ignores NoData raster responses', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      value: 'NoData',
      properties: { Values: ['NoData'] },
    }), { status: 200 }))

    const observations = await readNoiseObservations(
      { lat: 52.52, lng: 13.405 },
      [{
        source: 'aviation',
        indicator: 'lnight',
        imageServerUrl: 'https://noise.example.test/NoiseContours_air_lnight/ImageServer',
      }],
      {
        checkedAt: '2026-07-29T00:00:00.000Z',
        fetchImpl,
      },
    )

    expect(observations).toEqual([])
  })

  it('keeps successful layer observations when another layer fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('NoiseContours_rail_lden')) {
        return new Response('unavailable', { status: 503 })
      }
      return new Response(JSON.stringify({
        value: '3',
        catalogItems: {
          features: [{ attributes: { Name: 'DE_DF4_8_roadNoise_Lden_DE' } }],
        },
      }), { status: 200 })
    })

    const observations = await readNoiseObservations(
      { lat: 52.52, lng: 13.405 },
      [
        {
          source: 'road',
          indicator: 'lden',
          imageServerUrl: 'https://noise.example.test/NoiseContours_road_lden/ImageServer',
        },
        {
          source: 'rail',
          indicator: 'lden',
          imageServerUrl: 'https://noise.example.test/NoiseContours_rail_lden/ImageServer',
        },
      ],
      {
        checkedAt: '2026-07-29T00:00:00.000Z',
        fetchImpl,
      },
    )

    expect(observations).toEqual([expect.objectContaining({
      source: 'road',
      level: 'medium',
    })])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rail/lden identify failed'))
  })
})

describe('applyEnvironmentalNoise', () => {
  it('raises road and aviation noise levels from official EEA contour observations', () => {
    const enhanced = applyEnvironmentalNoise(locationContext(), [
      {
        source: 'road',
        indicator: 'lden',
        level: 'high',
        bandLabel: '>=75 dB Lden',
        minDb: 75,
        maxDb: null,
        value: 5,
        sourceLayerName: 'DE_DF4_8_roadNoise_Lden_DE',
        sourceLabel: 'EEA Environmental Noise Directive data',
        sourceUrl: 'https://www.eea.europa.eu/data-and-maps/data/data-on-noise-exposure-8',
        checkedAt: '2026-07-29T00:00:00.000Z',
      },
      {
        source: 'aviation',
        indicator: 'lnight',
        level: 'medium',
        bandLabel: '55-59 dB Lnight',
        minDb: 55,
        maxDb: 59,
        value: 2,
        sourceLayerName: 'DE_DF4_8_aircraftNoise_Lnight_DE',
        sourceLabel: 'EEA Environmental Noise Directive data',
        sourceUrl: 'https://www.eea.europa.eu/data-and-maps/data/data-on-noise-exposure-8',
        checkedAt: '2026-07-29T00:00:00.000Z',
      },
    ])

    expect(enhanced.environment.noisyRoadLevel).toBe('high')
    expect(enhanced.environment.aviationNoiseLevel).toBe('medium')
    expect(enhanced.environment.reportedNoise).toHaveLength(2)
    expect(enhanced.environment.riskSignals).toEqual(expect.arrayContaining([
      'eea_road_noise_high',
      'eea_aviation_noise_medium',
    ]))
    expect(enhanced.quality.score).toBe(59)
    expect(enhanced.quality.weaknesses).toEqual(expect.arrayContaining([
      'high_noise_road_pressure',
      'medium_aviation_noise_pressure',
    ]))
    expect(enhanced.quality.caveats).toContain('eea_end_noise_data')
    expect(enhanced.source.label).toContain('EEA Environmental Noise Directive data')
  })
})

describe('createEeaEnvironmentalNoiseEnhancer', () => {
  it('uses the configured EEA service base URL', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      value: '1',
    }), { status: 200 }))
    const enhancer = createEeaEnvironmentalNoiseEnhancer({
      checkedAt: '2026-07-29T00:00:00.000Z',
      serviceBaseUrl: 'https://noise.example.test/services/noiseStoryMap',
      fetchImpl,
    })

    await enhancer.enhance(auction(), locationContext())

    expect(fetchImpl).toHaveBeenCalledTimes(6)
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('https://noise.example.test/services/noiseStoryMap/NoiseContours_road_lden/ImageServer/identify')
  })
})
