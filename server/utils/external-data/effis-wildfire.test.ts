import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import {
  buildEffisWildfireHazardAssessments,
  createEffisWildfireFileAdapter,
  importEffisCurrentFireDangerCache,
  loadEffisWildfireCache,
  severityFromFwi,
} from './effis-wildfire'

let tmp: string | null = null

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true })
  tmp = null
})

const fixturePath = join(process.cwd(), 'server/utils/external-data/fixtures/effis-wildfire.fixture.json')
const checkedAt = '2026-07-26T12:00:00.000Z'

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'test',
    country: 'fr',
    region: 'Paris',
    externalId: '42',
    caseNumber: 'FR-42',
    authority: 'Tribunal',
    title: 'Maison',
    address: 'Paris',
    marketValueEur: 400_000,
    marketValueText: '400.000 EUR',
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
    lat: 48.8566,
    lng: 2.3522,
    ...overrides,
  }
}

describe('EFFIS wildfire cache evaluation', () => {
  it('maps fixture static risk and current fire danger conservatively', async () => {
    const cache = loadEffisWildfireCache(await readFile(fixturePath, 'utf8'))

    expect(buildEffisWildfireHazardAssessments(auction(), cache, { checkedAt })).toEqual([
      expect.objectContaining({
        hazard: 'wildfire',
        status: 'inside',
        severity: 'high',
        sourceLabel: 'Copernicus EFFIS wildfire risk',
        checkedAt,
      }),
      expect.objectContaining({
        hazard: 'wildfire',
        status: 'inside',
        severity: 'very_high',
        sourceLabel: 'Copernicus EFFIS fire danger forecast',
        checkedAt,
      }),
    ])
  })

  it('does not turn low current fire danger into outside/safe', async () => {
    const cache = loadEffisWildfireCache(await readFile(fixturePath, 'utf8'))

    const result = buildEffisWildfireHazardAssessments(
      auction({ country: 'de', lat: 52.52, lng: 13.405 }),
      cache,
      { checkedAt },
    )

    expect(result).toEqual([
      expect.objectContaining({ status: 'unknown', severity: 'low' }),
      expect.objectContaining({ status: 'unknown', severity: 'low' }),
    ])
    expect(result.every((hazard) => hazard.status !== 'outside')).toBe(true)
  })

  it('marks stale current forecasts as unknown', async () => {
    const cache = loadEffisWildfireCache(JSON.stringify({
      sourceVersion: 'stale',
      generatedAt: '2026-07-26T00:00:00.000Z',
      currentFireDanger: {
        generatedAt: '2026-07-24T00:00:00.000Z',
        validFor: '2026-07-24',
        ttlHours: 12,
        model: 'ecmwf',
        layer: 'ecmwf.fwi',
        cells: [{ lat: 48.8566, lng: 2.3522, radiusMeters: 10_000, fwi: 60 }],
      },
    }))

    expect(buildEffisWildfireHazardAssessments(auction(), cache, { checkedAt })).toContainEqual(expect.objectContaining({
      status: 'unknown',
      severity: 'unknown',
      stale: true,
      sourceLabel: 'Copernicus EFFIS fire danger forecast',
    }))
  })

  it('creates an external-enrichment adapter from a local EFFIS cache', async () => {
    const adapter = await createEffisWildfireFileAdapter({ cachePath: fixturePath, checkedAt })

    await expect(adapter.assess(auction())).resolves.toContainEqual(expect.objectContaining({
      hazard: 'wildfire',
      status: 'inside',
      severity: 'very_high',
    }))
    expect(adapter.id).toBe('effis-wildfire-file-cache')
    expect(adapter.sourceVersion).toBe('effis-fixture-v1')
  })
})

describe('EFFIS current fire danger import', () => {
  it('samples the official WMS FWI layer into a local cache', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'zvg-effis-'))
    const cachePath = join(tmp, 'effis-wildfire.json')
    const fetchImpl = async (url: URL) => {
      expect(url.searchParams.get('REQUEST')).toBe('GetFeatureInfo')
      expect(url.searchParams.get('LAYERS')).toBe('ecmwf.fwi')
      expect(url.searchParams.get('TIME')).toBe('2026-07-26')
      return new Response(JSON.stringify({
        features: [{ properties: { fwi: 39.2 } }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    const summary = await importEffisCurrentFireDangerCache({
      cachePath,
      serviceUrl: 'https://example.test/gwis',
      generatedAt: '2026-07-26T06:00:00.000Z',
      validFor: '2026-07-26',
      points: [{ lat: 48.8566, lng: 2.3522 }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(summary).toMatchObject({ requested: 1, sampled: 1 })
    const cached = loadEffisWildfireCache(await readFile(cachePath, 'utf8'))
    expect(cached.currentFireDanger?.cells).toEqual([expect.objectContaining({
      fwi: 39.2,
      severity: 'very_high',
    })])
  })

  it('preserves existing static risk cells when refreshing current fire danger', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'zvg-effis-'))
    const cachePath = join(tmp, 'effis-wildfire.json')
    await writeFile(cachePath, JSON.stringify({
      sourceVersion: 'old',
      generatedAt: '2026-07-01T00:00:00.000Z',
      staticRisk: {
        generatedAt: '2026-07-01T00:00:00.000Z',
        cells: [{ lat: 48.8566, lng: 2.3522, radiusMeters: 12_000, severity: 'high' }],
      },
    }))

    await importEffisCurrentFireDangerCache({
      cachePath,
      serviceUrl: 'https://example.test/gwis',
      generatedAt: '2026-07-26T06:00:00.000Z',
      validFor: '2026-07-26',
      points: [{ lat: 48.8566, lng: 2.3522 }],
      fetchImpl: (async () => new Response(JSON.stringify({ features: [{ properties: { fwi: 39.2 } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    })

    const cached = loadEffisWildfireCache(await readFile(cachePath, 'utf8'))
    expect(cached.staticRisk?.cells).toEqual([expect.objectContaining({ severity: 'high' })])
    expect(cached.currentFireDanger?.cells).toEqual([expect.objectContaining({ severity: 'very_high' })])
  })

  it('uses official EFFIS FWI thresholds', () => {
    expect(severityFromFwi(4)).toBe('low')
    expect(severityFromFwi(12)).toBe('medium')
    expect(severityFromFwi(22)).toBe('high')
    expect(severityFromFwi(50)).toBe('very_high')
  })
})
