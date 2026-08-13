import { describe, expect, it } from 'vitest'
import type { LocationContext, LocationNoiseObservation } from '~/types/auction'
import { mergeLocationContextWithPrevious } from './location-context-merge'

function baseContext(overrides: Partial<LocationContext['environment']> = {}): LocationContext {
  return {
    nearbyPlaces: [],
    mobility: {
      publicTransportLevel: 'none',
      nearestStopDistanceMeters: null,
      stopCountWithin1000m: 0,
      stopCountWithin3000m: 0,
      nearestRailStationDistanceMeters: null,
      roadAccessLevel: 'remote',
      nearestMajorRoadDistanceMeters: null,
      majorRoadKinds: [],
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
      heavyIndustrySites: [],
      noisyRoadLevel: 'unknown',
      aviationNoiseLevel: 'unknown',
      nearestMotorwayDistanceMeters: null,
      nearestPrimaryRoadDistanceMeters: null,
      nearestAirportDistanceMeters: null,
      nearestRunwayDistanceMeters: null,
      nearestHelipadDistanceMeters: null,
      nearestAirportName: null,
      nearestAirportKind: 'unknown',
      riskSignals: [],
      ...overrides,
    },
    demographics: {
      youthSignal: 'unknown',
      employmentSignal: 'unknown',
      declineRisk: 'unknown',
      universityDistanceMeters: null,
      schoolOrChildcareCountWithin3000m: 0,
      workplaceSignalCountWithin5000m: 0,
      reasons: [],
      caveats: [],
    },
    mapFeatures: [],
    neighborhood: {
      settlementPattern: 'unknown',
      buildingCountWithin500m: 0,
      buildingDensityPerSqKm: null,
      amenityCountWithin1000m: 0,
      vacantOrRuinCountWithin500m: 0,
      notes: [],
    },
    quality: { score: 50, verdict: 'average', strengths: [], weaknesses: [], caveats: [] },
    source: { id: 'openstreetmap-overpass', label: 'OSM', url: 'https://example.test', licenseNote: '' },
    checkedAt: '2026-08-13T00:00:00.000Z',
  }
}

function noise(source: LocationNoiseObservation['source'], indicator: LocationNoiseObservation['indicator'], checkedAt: string): LocationNoiseObservation {
  return {
    source,
    indicator,
    level: 'medium',
    bandLabel: '60-64 dB',
    minDb: 60,
    maxDb: 64,
    value: 2,
    sourceLayerName: null,
    sourceLabel: 'EEA',
    sourceUrl: 'https://example.test/eea',
    checkedAt,
  }
}

describe('mergeLocationContextWithPrevious', () => {
  it('returns context unchanged when there is no previous run', () => {
    const context = baseContext()
    expect(mergeLocationContextWithPrevious(context, null)).toBe(context)
  })

  it('keeps this run’s air quality and climate normals when present, ignoring previous', () => {
    const context = baseContext({
      airQuality: { index: 10, level: 'good', particulateMatter10: 1, particulateMatter25: 1, nitrogenDioxide: 1, ozone: 1, observedAt: null, sourceLabel: 'CAMS', sourceUrl: 'x', checkedAt: '2026-08-13T00:00:00.000Z' },
    })
    const previous = baseContext({
      airQuality: { index: 99, level: 'poor', particulateMatter10: 9, particulateMatter25: 9, nitrogenDioxide: 9, ozone: 9, observedAt: null, sourceLabel: 'CAMS', sourceUrl: 'x', checkedAt: '2026-08-01T00:00:00.000Z' },
    })
    const merged = mergeLocationContextWithPrevious(context, previous)
    expect(merged.environment.airQuality?.checkedAt).toBe('2026-08-13T00:00:00.000Z')
  })

  it('falls back to the previous run’s air quality and climate normals when this run has none', () => {
    const context = baseContext()
    const previous = baseContext({
      airQuality: { index: 99, level: 'poor', particulateMatter10: 9, particulateMatter25: 9, nitrogenDioxide: 9, ozone: 9, observedAt: null, sourceLabel: 'CAMS', sourceUrl: 'x', checkedAt: '2026-08-01T00:00:00.000Z' },
      climateNormals: { periodStartYear: 1991, periodEndYear: 2020, months: [], sourceLabel: 'Open-Meteo', sourceUrl: 'x', checkedAt: '2026-07-01T00:00:00.000Z' },
    })
    const merged = mergeLocationContextWithPrevious(context, previous)
    expect(merged.environment.airQuality).toEqual(previous.environment.airQuality)
    expect(merged.environment.climateNormals).toEqual(previous.environment.climateNormals)
  })

  it('merges noise observations by source+indicator, preferring this run’s value and keeping unrefreshed layers', () => {
    const context = baseContext({
      reportedNoise: [noise('road', 'lden', '2026-08-13T00:00:00.000Z')],
    })
    const previous = baseContext({
      reportedNoise: [
        noise('road', 'lden', '2026-08-01T00:00:00.000Z'),
        noise('rail', 'lnight', '2026-07-01T00:00:00.000Z'),
      ],
    })
    const merged = mergeLocationContextWithPrevious(context, previous)
    expect(merged.environment.reportedNoise).toHaveLength(2)
    expect(merged.environment.reportedNoise?.find((o) => o.source === 'road')?.checkedAt).toBe('2026-08-13T00:00:00.000Z')
    expect(merged.environment.reportedNoise?.find((o) => o.source === 'rail')?.checkedAt).toBe('2026-07-01T00:00:00.000Z')
  })
})
