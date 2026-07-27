import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import {
  buildAvalancheDiscoveryAssessment,
  createAvalancheDiscoveryAdapter,
  loadAvalancheDiscoveryCache,
} from './avalanche'

const fixturePath = join(process.cwd(), 'server/utils/external-data/fixtures/avalanche-discovery.fixture.json')
const checkedAt = '2026-07-26T12:00:00.000Z'

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'test',
    country: 'at',
    region: 'Tirol',
    externalId: '42',
    caseNumber: 'AT-42',
    authority: 'Bezirksgericht',
    title: 'Haus',
    address: 'Innsbruck',
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
    lat: 47.2692,
    lng: 11.4041,
    ...overrides,
  }
}

describe('avalanche discovery metadata', () => {
  it('models unconfirmed national services as unknown, never outside', async () => {
    const cache = loadAvalancheDiscoveryCache(await readFile(fixturePath, 'utf8'))

    expect(buildAvalancheDiscoveryAssessment(auction(), cache, { checkedAt })).toMatchObject({
      hazard: 'avalanche',
      status: 'unknown',
      severity: 'unknown',
      sourceLabel: 'HORA Austria Natural Hazard Overview',
      sourceUrl: 'https://hora.gv.at/',
      checkedAt,
    })
  })

  it('models unsupported countries as unknown', async () => {
    const cache = loadAvalancheDiscoveryCache(await readFile(fixturePath, 'utf8'))

    expect(buildAvalancheDiscoveryAssessment(auction({ country: 'fr' }), cache, { checkedAt })).toMatchObject({
      hazard: 'avalanche',
      status: 'unknown',
      severity: 'unknown',
      sourceLabel: 'European Avalanche Warning Services',
      sourceUrl: 'https://www.avalanches.org/',
    })
  })

  it('marks stale discovery metadata as unknown', async () => {
    const cache = loadAvalancheDiscoveryCache(JSON.stringify({
      sourceVersion: 'old',
      generatedAt: '2024-01-01T00:00:00.000Z',
      services: [],
    }))

    expect(buildAvalancheDiscoveryAssessment(auction(), cache, {
      checkedAt,
      maxCacheAgeDays: 10,
    })).toMatchObject({
      status: 'unknown',
      severity: 'unknown',
      stale: true,
    })
  })

  it('creates an adapter from a local discovery cache', async () => {
    const adapter = await createAvalancheDiscoveryAdapter({ metadataPath: fixturePath, checkedAt })

    await expect(adapter.assess(auction())).resolves.toEqual([expect.objectContaining({
      hazard: 'avalanche',
      status: 'unknown',
    })])
    expect(adapter.id).toBe('avalanche-discovery-cache')
    expect(adapter.sourceVersion).toBe('eaws-discovery-fixture-v1')
  })
})
