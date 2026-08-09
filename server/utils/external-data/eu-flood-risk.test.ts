import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import {
  buildFloodHazardAssessment,
  createEuFloodRiskFileAdapter,
  distanceToPolygonMeters,
  type GeoJsonPolygonCoordinates,
  importEuFloodRiskGeoJsonCache,
  loadFloodRiskGeoJson,
  pointInPolygon,
} from './eu-flood-risk'

let tmp: string | null = null

afterEach(async () => {
  vi.useRealTimers()
  if (tmp) await rm(tmp, { recursive: true, force: true })
  tmp = null
})

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'test',
    country: 'de',
    region: 'Berlin',
    externalId: '42',
    caseNumber: '1 K 1/26',
    authority: 'AG Test',
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
    lng: 13.4,
    ...overrides,
  }
}

const fixturePath = join(process.cwd(), 'server/utils/external-data/fixtures/eu-flood-risk-zones.fixture.geojson')
const checkedAt = '2026-07-26T00:00:00.000Z'

describe('pointInPolygon', () => {
  const polygon: GeoJsonPolygonCoordinates = [[
    [13.39, 52.51],
    [13.41, 52.51],
    [13.41, 52.53],
    [13.39, 52.53],
    [13.39, 52.51],
  ]]

  it('detects points inside and outside a GeoJSON polygon', () => {
    expect(pointInPolygon({ lat: 52.52, lng: 13.4 }, polygon)).toBe(true)
    expect(pointInPolygon({ lat: 52.54, lng: 13.4 }, polygon)).toBe(false)
  })

  it('excludes holes from polygon containment', () => {
    const withHole: GeoJsonPolygonCoordinates = [
      polygon[0]!,
      [
        [13.398, 52.518],
        [13.402, 52.518],
        [13.402, 52.522],
        [13.398, 52.522],
        [13.398, 52.518],
      ],
    ]

    expect(pointInPolygon({ lat: 52.52, lng: 13.4 }, withHole)).toBe(false)
    expect(pointInPolygon({ lat: 52.526, lng: 13.4 }, withHole)).toBe(true)
  })
})

describe('distanceToPolygonMeters', () => {
  it('returns zero inside and a nearby edge distance outside', () => {
    const polygon: GeoJsonPolygonCoordinates = [[
      [13.39, 52.51],
      [13.41, 52.51],
      [13.41, 52.53],
      [13.39, 52.53],
      [13.39, 52.51],
    ]]

    expect(distanceToPolygonMeters({ lat: 52.52, lng: 13.4 }, polygon)).toBe(0)
    expect(distanceToPolygonMeters({ lat: 52.535, lng: 13.4 }, polygon)).toBeGreaterThan(500)
    expect(distanceToPolygonMeters({ lat: 52.535, lng: 13.4 }, polygon)).toBeLessThan(600)
  })

  it('does not blow the call stack on a ring with tens of thousands of vertices', () => {
    // Real burnt-area/flood-risk polygons (e.g. Copernicus EFFIS) can have
    // rings this large. Math.min(...array) would throw "Maximum call stack
    // size exceeded" here — regression test for that.
    const vertexCount = 100_000
    const ring: GeoJsonPolygonCoordinates[number] = Array.from({ length: vertexCount }, (_, i) => {
      const angle = (i / vertexCount) * 2 * Math.PI
      return [13.4 + 0.01 * Math.cos(angle), 52.52 + 0.01 * Math.sin(angle)] as [number, number]
    })
    ring.push(ring[0]!)
    const polygon: GeoJsonPolygonCoordinates = [ring]

    expect(() => distanceToPolygonMeters({ lat: 52.6, lng: 13.4 }, polygon)).not.toThrow()
    const distance = distanceToPolygonMeters({ lat: 52.6, lng: 13.4 }, polygon)
    expect(Number.isFinite(distance)).toBe(true)
    expect(distance).toBeGreaterThan(0)
  })
})

describe('buildFloodHazardAssessment', () => {
  it('evaluates polygon and MultiPolygon fixtures with source attribution', async () => {
    const collection = loadFloodRiskGeoJson(await readFile(fixturePath, 'utf8'), {
      sourceVersion: 'fixture-v1',
      generatedAt: checkedAt,
    })

    expect(collection.zones).toHaveLength(2)
    expect(buildFloodHazardAssessment(auction(), collection, { checkedAt })).toMatchObject({
      hazard: 'flood',
      status: 'inside',
      severity: 'high',
      distanceMeters: 0,
      sourceLabel: 'EU Flood Risk Areas',
      sourceUrl: 'https://water.europa.eu/freshwater/resources/eu-flood-risk-areas-viewer',
      checkedAt,
    })
    expect(buildFloodHazardAssessment(auction({ country: 'fr', lat: 48.8566, lng: 2.3522 }), collection, { checkedAt })).toMatchObject({
      status: 'inside',
      severity: 'medium',
    })
  })

  it('distinguishes nearby, outside and unknown without safe language', async () => {
    const collection = loadFloodRiskGeoJson(await readFile(fixturePath, 'utf8'), {
      sourceVersion: 'fixture-v1',
      generatedAt: checkedAt,
    })

    expect(buildFloodHazardAssessment(
      auction({ lat: 52.535, lng: 13.4 }),
      collection,
      { checkedAt, nearbyDistanceMeters: 1_000 },
    )).toMatchObject({
      status: 'nearby',
      severity: 'high',
      distanceMeters: expect.any(Number),
    })
    expect(buildFloodHazardAssessment(
      auction({ lat: 52.7, lng: 13.4 }),
      collection,
      { checkedAt, nearbyDistanceMeters: 1_000 },
    )).toMatchObject({
      status: 'outside',
      severity: 'unknown',
    })
    expect(buildFloodHazardAssessment(auction(), {
      sourceVersion: 'empty',
      generatedAt: checkedAt,
      zones: [],
    }, { checkedAt })).toMatchObject({
      status: 'unknown',
      severity: 'unknown',
      distanceMeters: null,
    })
  })

  it('treats the nearby threshold as an inclusive source-specific meter distance', () => {
    const polygon: GeoJsonPolygonCoordinates = [[
      [13.39, 52.51],
      [13.41, 52.51],
      [13.41, 52.53],
      [13.39, 52.53],
      [13.39, 52.51],
    ]]
    const point = auction({ lat: 52.535, lng: 13.4 })
    const collection = {
      sourceVersion: 'fixture-v1',
      generatedAt: checkedAt,
      zones: [{ id: 'zone-1', polygons: [polygon], severity: 'high' as const, properties: {} }],
    }
    const distance = distanceToPolygonMeters({ lat: point.lat!, lng: point.lng! }, polygon)

    expect(buildFloodHazardAssessment(point, collection, {
      checkedAt,
      nearbyDistanceMeters: distance - 0.1,
    })).toMatchObject({ status: 'outside' })
    expect(buildFloodHazardAssessment(point, collection, {
      checkedAt,
      nearbyDistanceMeters: distance,
    })).toMatchObject({ status: 'nearby' })
    expect(buildFloodHazardAssessment(point, collection, {
      checkedAt,
      nearbyDistanceMeters: distance + 0.1,
    })).toMatchObject({ status: 'nearby' })
  })

  it('marks stale caches as unknown rather than outside', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-27T00:00:00.000Z'))
    const collection = loadFloodRiskGeoJson(await readFile(fixturePath, 'utf8'), {
      sourceVersion: 'fixture-v1',
      generatedAt: '2024-01-01T00:00:00.000Z',
    })

    expect(buildFloodHazardAssessment(auction({ lat: 52.7, lng: 13.4 }), collection, {
      checkedAt,
      maxCacheAgeDays: 30,
    })).toMatchObject({
      status: 'unknown',
      severity: 'unknown',
      distanceMeters: null,
      stale: true,
    })
  })

  it('creates an external-enrichment hazard adapter from a local GeoJSON cache', async () => {
    const adapter = await createEuFloodRiskFileAdapter({
      geoJsonPath: fixturePath,
      sourceVersion: 'fixture-v1',
      checkedAt,
    })

    await expect(adapter.assess(auction())).resolves.toEqual([
      expect.objectContaining({
        hazard: 'flood',
        status: 'inside',
        severity: 'high',
        checkedAt,
      }),
    ])
    expect(adapter.id).toBe('eu-flood-risk-file-cache')
    expect(adapter.sourceVersion).toBe('fixture-v1')
  })
})

describe('importEuFloodRiskGeoJsonCache', () => {
  it('paginates ArcGIS REST GeoJSON into a local metadata-rich cache', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'zvg-eu-flood-'))
    const cachePath = join(tmp, 'eu-flood-risk.geojson')
    const fetchImpl = vi.fn(async (url: URL) => {
      const offset = Number(url.searchParams.get('resultOffset'))
      const page = offset === 0
        ? {
            type: 'FeatureCollection',
            features: [{
              type: 'Feature',
              properties: { OBJECTID: 1, countryCode: 'DE', hazardCategory: 'flood' },
              geometry: {
                type: 'Polygon',
                coordinates: [[
                  [13.39, 52.51],
                  [13.41, 52.51],
                  [13.41, 52.53],
                  [13.39, 52.53],
                  [13.39, 52.51],
                ]],
              },
            }],
          }
        : { type: 'FeatureCollection', features: [] }
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const summary = await importEuFloodRiskGeoJsonCache({
      cachePath,
      serviceUrl: 'https://example.test/MapServer/2',
      sourceVersion: 'flood-v1',
      generatedAt: checkedAt,
      pageSize: 1,
      countryCodes: ['de'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(summary).toMatchObject({
      cachePath,
      serviceUrl: 'https://example.test/MapServer/2',
      sourceVersion: 'flood-v1',
      generatedAt: checkedAt,
      fetched: 1,
      normalized: 1,
      pages: 2,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const firstUrl = fetchImpl.mock.calls[0]?.[0] as URL
    expect(firstUrl.searchParams.get('f')).toBe('geojson')
    expect(firstUrl.searchParams.get('where')).toBe("countryCode IN ('DE')")
    expect(firstUrl.searchParams.get('outSR')).toBe('4326')

    const cached = loadFloodRiskGeoJson(await readFile(cachePath, 'utf8'), {})
    expect(cached).toMatchObject({
      sourceVersion: 'flood-v1',
      generatedAt: checkedAt,
      zones: [{ properties: { countryCode: 'DE' } }],
    })
  })

  it('surfaces ArcGIS errors instead of writing a cache', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'zvg-eu-flood-'))
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'Invalid query' },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    await expect(importEuFloodRiskGeoJsonCache({
      cachePath: join(tmp, 'eu-flood-risk.geojson'),
      serviceUrl: 'https://example.test/MapServer/2',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow('Invalid query')
    // A logical ArcGIS error (bad query, bad response shape) fails identically
    // at any page size — must reject on the first request, not split-retry it
    // into a dozen more requests that all fail the same way.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('splits a page into smaller retried requests on a 5xx from the layer', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'zvg-eu-flood-'))
    const fetchImpl = vi.fn(async (url: URL) => {
      const count = Number(url.searchParams.get('resultRecordCount'))
      if (count > 10) return new Response('Internal Server Error', { status: 500 })
      const offset = Number(url.searchParams.get('resultOffset'))
      return new Response(JSON.stringify({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          properties: { OBJECTID: offset + 1, countryCode: 'DE' },
          geometry: {
            type: 'Polygon',
            coordinates: [[
              [13.39, 52.51],
              [13.41, 52.51],
              [13.41, 52.53],
              [13.39, 52.53],
              [13.39, 52.51],
            ]],
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const summary = await importEuFloodRiskGeoJsonCache({
      cachePath: join(tmp, 'eu-flood-risk.geojson'),
      serviceUrl: 'https://example.test/MapServer/2',
      pageSize: 20,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(summary.fetched).toBe(2)
    // 1 failed 20-row request, then 2 successful 10-row halves.
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('does not split a failing page below MIN_PAGE_SIZE', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'zvg-eu-flood-'))
    const fetchImpl = vi.fn(async () => new Response('Internal Server Error', { status: 500 }))

    await expect(importEuFloodRiskGeoJsonCache({
      cachePath: join(tmp, 'eu-flood-risk.geojson'),
      serviceUrl: 'https://example.test/MapServer/2',
      pageSize: 13,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow('500')

    // 13 < MIN_PAGE_SIZE * 2 — splitting would create a sub-10-row request.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
