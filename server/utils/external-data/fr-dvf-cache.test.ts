import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import {
  buildDvfTransactionCache,
  candidateDvfTransactionsForAuction,
  createDvfFileMarketAdapter,
  importDvfCsvFileToCache,
  loadDvfCsv,
  loadDvfCsvFile,
  readDvfTransactionCache,
} from './fr-dvf-cache'
import { encodeGeohash } from './geohash'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

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

describe('loadDvfCsv mutations', () => {
  it('groups consecutive rows of one mutation into a single transaction', () => {
    const content = [
      'id_mutation;valeur_fonciere;type_local;surface_reelle_bati;lot1_numero;latitude;longitude',
      'm1;600000;Appartement;50;1;48,8566;2,3522',
      'm1;600000;Appartement;70;2;48,8566;2,3522',
      'm2;300000;Maison;100;;48,8566;2,3522',
    ].join('\n')

    const result = loadDvfCsv(content)

    expect(result).toMatchObject({ rows: 3, normalized: 2, dropped: 0 })
    expect(result.transactions.map((tx) => [tx.id, tx.builtAreaSqm])).toEqual([['m1', 120], ['m2', 100]])
  })
})

describe('loadDvfCsvFile', () => {
  it('parses identically however the stream splits quotes, escapes and CRLFs', async () => {
    const content = '\uFEFF' + [
      'id_mutation;date_mutation;valeur_fonciere;code_commune;commune;type_local;surface_reelle_bati;surface_terrain;latitude;longitude',
      'm1;2025-01-01;450000;75056;"Paris ""1er""; centre";Maison;100;300;48,8566;2,3522',
      'm2;2025-01-02;"500 000";75056;"";Appartement;50;;48,8566;2,3522',
      '',
    ].join('\r\n')
    const expected = loadDvfCsv(content)
    expect(expected.transactions[0]?.communeName).toBe('Paris "1er"; centre')
    expect(expected.normalized).toBe(2)

    for (let size = 1; size <= content.length; size++) {
      const chunks = Array.from({ length: Math.ceil(content.length / size) }, (_, i) => content.slice(i * size, (i + 1) * size))
      vi.mocked(createReadStream).mockReturnValueOnce(Readable.from(chunks) as ReturnType<typeof createReadStream>)
      await expect(loadDvfCsvFile('/dvf.csv'), `chunk size ${size}`).resolves.toEqual(expected)
    }
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

  it('includes sales across a geohash cell edge that are within the radius', () => {
    // 48.8671875° is a precision-4 cell edge; the sale is ~550 m north of it.
    const sale = { ...loadDvfCsv(csv(1)).transactions[0]!, lat: 48.87, lng: 2.3522 }
    const cache = buildDvfTransactionCache([sale], { sourceVersion: 'fixture-2025' })
    const nearby = auction({ lat: 48.865, lng: 2.3522 })
    expect(encodeGeohash(nearby.lat!, nearby.lng!, 4)).not.toBe(encodeGeohash(sale.lat, sale.lng, 4))

    expect(candidateDvfTransactionsForAuction(nearby, cache)).toEqual([sale])
    expect(candidateDvfTransactionsForAuction(nearby, cache, { radiusMeters: 100 })).toEqual([])
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

  it('shares one parsed cache between concurrently built adapters', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'zvg-dvf-'))
    const cachePath = join(tmp, 'dvf-cache.json')
    await writeFile(cachePath, JSON.stringify(buildDvfTransactionCache(loadDvfCsv(csv()).transactions, {
      sourceVersion: 'fixture-2025',
    })))
    vi.mocked(readFile).mockClear()

    const adapters = await Promise.all([1, 2, 3].map(() => createDvfFileMarketAdapter({ cachePath })))

    expect(vi.mocked(readFile).mock.calls.filter(([path]) => path === cachePath)).toHaveLength(1)
    for (const adapter of adapters) expect((await adapter.compare(auction()))?.samples).toBe(11)
  })

  it('treats a cache that was not imported yet as empty', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'zvg-dvf-'))

    const adapter = await createDvfFileMarketAdapter({ cachePath: join(tmp, 'missing.json') })

    expect(adapter.sourceVersion).toBe('missing')
    expect((await adapter.compare(auction()))?.verdict).toBe('insufficient_data')
  })
})
