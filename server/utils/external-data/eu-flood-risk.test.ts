import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import {
  buildFloodHazardAssessment,
  createEuFloodRiskFileAdapter,
  distanceToPolygonMeters,
  type GeoJsonPolygonCoordinates,
  loadFloodRiskGeoJson,
  pointInPolygon,
} from './eu-flood-risk'

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
