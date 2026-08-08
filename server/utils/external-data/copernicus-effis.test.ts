import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import {
  buildWildfireHazardAssessment,
  createCopernicusEffisBurntAreaFileAdapter,
  importCopernicusEffisBurntAreaCache,
  parseBurntAreaGml,
  readBurntAreaCache,
} from './copernicus-effis'

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

const fixturePath = join(process.cwd(), 'server/utils/external-data/fixtures/copernicus-effis-burnt-area.fixture.json')
const checkedAt = '2026-07-26T00:00:00.000Z'

// Trimmed real response shape verified live 2026-07-29 against
// https://maps.effis.emergency.copernicus.eu/effis (WFS 1.1.0,
// typename=modis.ba.poly, outputformat=GML3) — coordinates are lat,lng per
// EPSG:4326 axis order, which parseBurntAreaGml must flip to lng,lat.
function sampleGml(features: string): string {
  return `<?xml version='1.0' encoding="UTF-8" ?>
<wfs:FeatureCollection
   xmlns:ms="http://mapserver.gis.umn.edu/mapserver"
   xmlns:gml="http://www.opengis.net/gml"
   xmlns:wfs="http://www.opengis.net/wfs">
${features}
</wfs:FeatureCollection>`
}

function sampleFeature(id: string, posList: string, fireDate: string, country: string, areaHa: string): string {
  return `  <gml:featureMember>
    <ms:modis.ba.poly gml:id="${id}">
      <ms:msGeometry>
        <gml:Polygon srsName="EPSG:4326">
          <gml:exterior>
            <gml:LinearRing>
              <gml:posList srsDimension="2">${posList}</gml:posList>
            </gml:LinearRing>
          </gml:exterior>
        </gml:Polygon>
      </ms:msGeometry>
      <ms:FIREDATE>${fireDate}</ms:FIREDATE>
      <ms:COUNTRY>${country}</ms:COUNTRY>
      <ms:AREA_HA>${areaHa}</ms:AREA_HA>
    </ms:modis.ba.poly>
  </gml:featureMember>`
}

const BERLIN_POS_LIST = '52.51 13.39 52.51 13.41 52.53 13.41 52.53 13.39 52.51 13.39'

describe('parseBurntAreaGml', () => {
  it('parses features and flips GML lat,lng posList order to lng,lat', () => {
    const gml = sampleGml(sampleFeature('modis.ba.poly.1', BERLIN_POS_LIST, '2022-08-10 00:00:00', 'DE', '600'))
    const zones = parseBurntAreaGml(gml)

    expect(zones).toHaveLength(1)
    expect(zones[0]).toMatchObject({
      id: 'modis.ba.poly.1',
      fireDate: '2022-08-10 00:00:00',
      country: 'DE',
      areaHa: 600,
    })
    expect(zones[0]!.polygon[0]![0]).toEqual([13.39, 52.51])
  })

  it('parses multiple features and skips one with no geometry', () => {
    const gml = sampleGml([
      sampleFeature('modis.ba.poly.1', BERLIN_POS_LIST, '2022-08-10 00:00:00', 'DE', '600'),
      '  <gml:featureMember><ms:modis.ba.poly gml:id="modis.ba.poly.2"><ms:COUNTRY>ES</ms:COUNTRY></ms:modis.ba.poly></gml:featureMember>',
    ].join('\n'))

    expect(parseBurntAreaGml(gml)).toHaveLength(1)
  })

  it('treats a missing AREA_HA as null rather than zero', () => {
    const gml = sampleGml(
      '  <gml:featureMember><ms:modis.ba.poly gml:id="modis.ba.poly.3">' +
      `<ms:msGeometry><gml:Polygon srsName="EPSG:4326"><gml:exterior><gml:LinearRing>` +
      `<gml:posList srsDimension="2">${BERLIN_POS_LIST}</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></ms:msGeometry>` +
      '<ms:COUNTRY>DE</ms:COUNTRY></ms:modis.ba.poly></gml:featureMember>',
    )

    expect(parseBurntAreaGml(gml)[0]).toMatchObject({ areaHa: null })
  })
})

describe('buildWildfireHazardAssessment', () => {
  it('evaluates the fixture with source attribution and area-based severity', async () => {
    const collection = await readBurntAreaCache(fixturePath)
    expect(collection.zones).toHaveLength(2)

    expect(buildWildfireHazardAssessment(auction(), collection, { checkedAt })).toMatchObject({
      hazard: 'wildfire',
      status: 'inside',
      severity: 'high',
      distanceMeters: 0,
      sourceLabel: 'Copernicus EFFIS MODIS Burnt Area',
      checkedAt,
    })
    expect(buildWildfireHazardAssessment(
      auction({ country: 'fr', lat: 48.8566, lng: 2.3522 }),
      collection,
      { checkedAt },
    )).toMatchObject({ status: 'inside', severity: 'low' })
  })

  it('distinguishes nearby, outside and unknown without safe language', async () => {
    const collection = await readBurntAreaCache(fixturePath)

    expect(buildWildfireHazardAssessment(
      auction({ lat: 52.535, lng: 13.4 }),
      collection,
      { checkedAt, nearbyDistanceMeters: 1_000 },
    )).toMatchObject({ status: 'nearby', severity: 'high' })
    expect(buildWildfireHazardAssessment(
      auction({ lat: 53.5, lng: 13.4 }),
      collection,
      { checkedAt, nearbyDistanceMeters: 1_000 },
    )).toMatchObject({ status: 'outside', severity: 'unknown' })
    expect(buildWildfireHazardAssessment(auction(), {
      sourceVersion: 'empty',
      generatedAt: checkedAt,
      zones: [],
    }, { checkedAt })).toMatchObject({ status: 'unknown', severity: 'unknown', distanceMeters: null })
  })

  it('reports unknown severity when the matched zone has no AREA_HA', () => {
    const collection = {
      sourceVersion: 'v1',
      generatedAt: checkedAt,
      zones: [{
        id: 'z1',
        polygon: [[[13.39, 52.51], [13.41, 52.51], [13.41, 52.53], [13.39, 52.53], [13.39, 52.51]]] as const,
        fireDate: null,
        country: null,
        areaHa: null,
      }],
    }

    expect(buildWildfireHazardAssessment(auction(), collection as never, { checkedAt })).toMatchObject({
      status: 'inside',
      severity: 'unknown',
    })
  })

  it('marks stale caches as unknown rather than outside', async () => {
    const collection = await readBurntAreaCache(fixturePath)

    expect(buildWildfireHazardAssessment(auction({ lat: 53.5, lng: 13.4 }), { ...collection, generatedAt: '2024-01-01T00:00:00.000Z' }, {
      checkedAt,
      maxCacheAgeDays: 30,
    })).toMatchObject({ status: 'unknown', severity: 'unknown', distanceMeters: null, stale: true })
  })

  it('creates an external-enrichment hazard adapter from a local cache', async () => {
    const adapter = await createCopernicusEffisBurntAreaFileAdapter({
      cachePath: fixturePath,
      sourceVersion: 'fixture-v1',
      checkedAt,
    })

    await expect(adapter.assess(auction())).resolves.toEqual([
      expect.objectContaining({ hazard: 'wildfire', status: 'inside', severity: 'high', checkedAt }),
    ])
    expect(adapter.id).toBe('copernicus-effis-burnt-area-file-cache')
    expect(adapter.sourceVersion).toBe('fixture-v1')
  })
})

describe('importCopernicusEffisBurntAreaCache', () => {
  it('paginates WFS GML pages into a local normalized cache', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'zvg-effis-'))
    const cachePath = join(tmp, 'copernicus-effis.json')
    const fetchImpl = vi.fn(async (url: URL) => {
      const startIndex = Number(url.searchParams.get('startindex'))
      const body = startIndex === 0
        ? sampleGml(sampleFeature('modis.ba.poly.1', BERLIN_POS_LIST, '2022-08-10 00:00:00', 'DE', '600'))
        : sampleGml('')
      return new Response(body, { status: 200, headers: { 'content-type': 'text/xml' } })
    })

    const summary = await importCopernicusEffisBurntAreaCache({
      cachePath,
      serviceUrl: 'https://example.test/effis',
      sourceVersion: 'effis-v1',
      generatedAt: checkedAt,
      pageSize: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(summary).toMatchObject({
      cachePath,
      serviceUrl: 'https://example.test/effis',
      sourceVersion: 'effis-v1',
      generatedAt: checkedAt,
      fetched: 1,
      normalized: 1,
      pages: 2,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const firstUrl = fetchImpl.mock.calls[0]?.[0] as URL
    expect(firstUrl.searchParams.get('typename')).toBe('modis.ba.poly')
    expect(firstUrl.searchParams.get('outputformat')).toBe('GML3')
    expect(firstUrl.searchParams.get('bbox')).toContain('CRS84')

    const cached = await readBurntAreaCache(cachePath)
    expect(cached).toMatchObject({
      sourceVersion: 'effis-v1',
      generatedAt: checkedAt,
      zones: [{ country: 'DE', areaHa: 600 }],
    })
  })

  it('drops zones that are too old, too small, or missing the data to tell', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'zvg-effis-'))
    const cachePath = join(tmp, 'copernicus-effis.json')
    const gml = sampleGml([
      sampleFeature('recent-large', BERLIN_POS_LIST, '2022-08-10 00:00:00', 'DE', '600'), // kept: 4y old, 600ha
      sampleFeature('too-old', BERLIN_POS_LIST, '2016-08-10 00:00:00', 'DE', '600'), // dropped: 10y old
      sampleFeature('too-small', BERLIN_POS_LIST, '2022-08-10 00:00:00', 'DE', '2'), // dropped: below 10ha
      '  <gml:featureMember><ms:modis.ba.poly gml:id="no-date">' +
        `<ms:msGeometry><gml:Polygon srsName="EPSG:4326"><gml:exterior><gml:LinearRing>` +
        `<gml:posList srsDimension="2">${BERLIN_POS_LIST}</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></ms:msGeometry>` +
        '<ms:AREA_HA>600</ms:AREA_HA></ms:modis.ba.poly></gml:featureMember>', // dropped: no FIREDATE
    ].join('\n'))
    const fetchImpl = vi.fn(async (url: URL) => {
      const startIndex = Number(url.searchParams.get('startindex'))
      return new Response(startIndex === 0 ? gml : sampleGml(''), { status: 200, headers: { 'content-type': 'text/xml' } })
    })

    const summary = await importCopernicusEffisBurntAreaCache({
      cachePath,
      serviceUrl: 'https://example.test/effis',
      generatedAt: '2026-08-08T00:00:00.000Z',
      pageSize: 4,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(summary.fetched).toBe(4)
    expect(summary.normalized).toBe(1)
    const cached = await readBurntAreaCache(cachePath)
    expect(cached.zones.map((zone) => zone.id)).toEqual(['recent-large'])
  })

  it('surfaces request failures instead of writing a cache', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'zvg-effis-'))
    const fetchImpl = vi.fn(async () => new Response('error', { status: 500, statusText: 'Internal Server Error' }))

    await expect(importCopernicusEffisBurntAreaCache({
      cachePath: join(tmp, 'copernicus-effis.json'),
      serviceUrl: 'https://example.test/effis',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow('500')
  })
})

describe('readBurntAreaCache', () => {
  it('degrades a malformed cache file to zero zones instead of throwing', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'zvg-effis-'))
    const cachePath = join(tmp, 'copernicus-effis.json')
    await writeFile(cachePath, JSON.stringify({}), 'utf8')

    const collection = await readBurntAreaCache(cachePath)
    expect(collection.zones).toEqual([])
    expect(buildWildfireHazardAssessment(auction(), collection, { checkedAt })).toMatchObject({
      status: 'unknown',
      severity: 'unknown',
    })
  })
})
