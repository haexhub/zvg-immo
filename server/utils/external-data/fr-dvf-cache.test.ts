import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import {
  buildDvfTransactionCache,
  candidateDvfTransactionsForAuction,
  createDvfFileMarketAdapter,
  importDvfCsvFileToCache,
  loadDvfCsv,
  readDvfTransactionCache,
} from './fr-dvf-cache'
import { encodeGeohash } from './geohash'

let tmp: string | null = null

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true })
  tmp = null
})

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'fr-test',
    country: 'fr',
    region: 'Ile-de-France',
    externalId: '42',
    caseNumber: 'FR-42',
    authority: 'Tribunal judiciaire',
    title: 'Maison',
    address: 'Paris',
    marketValueEur: 400_000,
    marketValueText: '400 000 EUR',
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
    extraction: {
      propertyType: 'einfamilienhaus',
      landAreaSqm: 300,
      livingAreaSqm: 100,
      rooms: null,
      units: null,
      source: 'rules',
      confidence: 'high',
      at: '2026-07-26T00:00:00.000Z',
    },
    ...overrides,
  }
}

function csv(rows = 11): string {
  const header = [
    'id_mutation',
    'date_mutation',
    'valeur_fonciere',
    'code_commune',
    'commune',
    'type_local',
    'surface_reelle_bati',
    'surface_terrain',
    'latitude',
    'longitude',
  ].join(';')
  const body = Array.from({ length: rows }, (_, i) => [
    `m${i + 1}`,
    '2025-01-01',
    String(450_000 + i * 10_000),
    '75056',
    '"Paris, 1er"',
    'Maison',
    '100',
    '300',
    '48,8566',
    '2,3522',
  ].join(';'))
  return [header, ...body, 'bad;2025;0;75056;Paris;Maison;100;300;48,8566;2,3522'].join('\n')
}

describe('loadDvfCsv', () => {
  it('parses semicolon CSV with quoted fields and drops unusable rows', () => {
    const result = loadDvfCsv(csv(2))

    expect(result.rows).toBe(3)
    expect(result.normalized).toBe(2)
    expect(result.dropped).toBe(1)
    expect(result.transactions[0]).toMatchObject({
      id: 'm1',
      communeName: 'Paris, 1er',
      propertyClass: 'house',
      priceEur: 450_000,
      lat: 48.8566,
      lng: 2.3522,
    })
  })
})

describe('DvfTransactionCache', () => {
  it('indexes transactions by class, commune and geohash prefix', () => {
    const load = loadDvfCsv(csv(1))
    const cache = buildDvfTransactionCache(load.transactions, {
      sourceVersion: 'fixture-2025',
      generatedAt: '2026-07-26T00:00:00.000Z',
    })
    const geohash = encodeGeohash(48.8566, 2.3522, 4)

    expect(cache.groups.house?.byCommune['75056']).toEqual([0])
    expect(cache.groups.house?.byGeohash[geohash]).toEqual([0])
  })

  it('returns geohash-local candidates for an auction property class', () => {
    const load = loadDvfCsv(csv(2))
    const cache = buildDvfTransactionCache(load.transactions, { sourceVersion: 'fixture-2025' })

    expect(candidateDvfTransactionsForAuction(auction(), cache)).toHaveLength(2)
    expect(candidateDvfTransactionsForAuction(auction({ lat: 43.6047, lng: 1.4442 }), cache)).toEqual([])
  })

  it('imports a CSV file into a JSON cache that the adapter can use', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'zvg-dvf-'))
    const csvPath = join(tmp, 'dvf.csv')
    const cachePath = join(tmp, 'dvf-cache.json')
    await writeFile(csvPath, csv())

    const { load, cache } = await importDvfCsvFileToCache({
      csvPath,
      cachePath,
      sourceVersion: 'fixture-2025',
      generatedAt: '2026-07-26T00:00:00.000Z',
    })

    expect(load.normalized).toBe(11)
    expect(cache.sourceVersion).toBe('fixture-2025')
    expect(JSON.parse(await readFile(cachePath, 'utf8')).transactions).toHaveLength(11)
    await expect(readDvfTransactionCache(cachePath)).resolves.toMatchObject({
      sourceVersion: 'fixture-2025',
      transactions: expect.any(Array),
    })

    const adapter = await createDvfFileMarketAdapter({ cachePath })
    const comparison = await adapter.compare(auction())

    expect(adapter.sourceVersion).toBe('fixture-2025')
    expect(comparison?.samples).toBe(11)
    expect(comparison?.medianPricePerSqm).toBe(5000)
    expect(comparison?.verdict).toBe('cheaper')
  })
})
