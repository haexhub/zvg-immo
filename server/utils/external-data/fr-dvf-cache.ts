import { readFile } from 'node:fs/promises'
import type { Auction, MarketComparisonPropertyClass } from '~/types/auction'
import { readJsonCache, writeJsonCache } from '../json-cache'
import {
  buildDvfMarketComparison,
  normalizeDvfRow,
  type DvfMarketComparisonOptions,
  type DvfTransaction,
  type RawDvfRow,
} from './fr-dvf'
import { encodeGeohash } from './geohash'
import type { MarketComparisonAdapter } from '~/server/tasks/external-enrichment'

export interface DvfTransactionGroupIndex {
  byCommune: Record<string, number[]>
  byGeohash: Record<string, number[]>
}

export interface DvfTransactionCache {
  sourceVersion: string
  generatedAt: string
  transactions: DvfTransaction[]
  groups: Partial<Record<MarketComparisonPropertyClass, DvfTransactionGroupIndex>>
}

export interface DvfCsvLoadResult {
  rows: number
  normalized: number
  dropped: number
  transactions: DvfTransaction[]
}

export interface DvfFileMarketAdapterOptions extends DvfMarketComparisonOptions {
  cachePath: string
  sourceVersion?: string
  geohashPrefixLength?: number
}

export interface ImportDvfCsvFileOptions {
  csvPath: string
  cachePath: string
  sourceVersion: string
  generatedAt?: string
  geohashPrefixLength?: number
}

const DEFAULT_GEOHASH_PREFIX_LENGTH = 4

export async function loadDvfCsvFile(path: string): Promise<DvfCsvLoadResult> {
  return loadDvfCsv(await readFile(path, 'utf8'))
}

export async function importDvfCsvFileToCache(options: ImportDvfCsvFileOptions): Promise<{
  load: DvfCsvLoadResult
  cache: DvfTransactionCache
}> {
  const load = await loadDvfCsvFile(options.csvPath)
  const cache = buildDvfTransactionCache(load.transactions, {
    sourceVersion: options.sourceVersion,
    generatedAt: options.generatedAt,
    geohashPrefixLength: options.geohashPrefixLength,
  })
  await writeDvfTransactionCache(options.cachePath, cache)
  return { load, cache }
}

export function loadDvfCsv(content: string): DvfCsvLoadResult {
  const rows = parseDelimitedRows(content)
  const transactions: DvfTransaction[] = []
  for (const row of rows) {
    const normalized = normalizeDvfRow(row)
    if (normalized) transactions.push(normalized)
  }
  return {
    rows: rows.length,
    normalized: transactions.length,
    dropped: rows.length - transactions.length,
    transactions,
  }
}

export function buildDvfTransactionCache(
  transactions: DvfTransaction[],
  options: {
    sourceVersion: string
    generatedAt?: string
    geohashPrefixLength?: number
  },
): DvfTransactionCache {
  const geohashPrefixLength = options.geohashPrefixLength ?? DEFAULT_GEOHASH_PREFIX_LENGTH
  const groups: DvfTransactionCache['groups'] = {}
  for (const [index, tx] of transactions.entries()) {
    const group = groups[tx.propertyClass] ?? { byCommune: {}, byGeohash: {} }
    groups[tx.propertyClass] = group

    if (tx.communeCode) {
      const list = group.byCommune[tx.communeCode] ?? []
      list.push(index)
      group.byCommune[tx.communeCode] = list
    }

    const geohash = encodeGeohash(tx.lat, tx.lng, geohashPrefixLength)
    const list = group.byGeohash[geohash] ?? []
    list.push(index)
    group.byGeohash[geohash] = list
  }
  return {
    sourceVersion: options.sourceVersion,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    transactions,
    groups,
  }
}

export async function writeDvfTransactionCache(path: string, cache: DvfTransactionCache): Promise<void> {
  await writeJsonCache(path, cache)
}

export async function readDvfTransactionCache(path: string): Promise<DvfTransactionCache> {
  return readJsonCache<DvfTransactionCache>(
    path,
    () => ({ sourceVersion: 'missing', generatedAt: new Date(0).toISOString(), transactions: [], groups: {} }),
    'fr-dvf-cache',
  )
}

export function candidateDvfTransactionsForAuction(
  auction: Auction,
  cache: DvfTransactionCache,
  options: { geohashPrefixLength?: number } = {},
): DvfTransaction[] {
  if (auction.lat == null || auction.lng == null) return []
  const propertyClass = marketClassForAuction(auction)
  const group = cache.groups[propertyClass]
  if (!group) return []
  const geohash = encodeGeohash(
    auction.lat,
    auction.lng,
    options.geohashPrefixLength ?? DEFAULT_GEOHASH_PREFIX_LENGTH,
  )
  const indexes = group.byGeohash[geohash] ?? []
  return indexes.map((index) => cache.transactions[index]).filter((tx): tx is DvfTransaction => !!tx)
}

export async function createDvfFileMarketAdapter(
  options: DvfFileMarketAdapterOptions,
): Promise<MarketComparisonAdapter> {
  const cache = await readDvfTransactionCache(options.cachePath)
  return {
    id: 'fr-dvf-file-cache',
    sourceVersion: options.sourceVersion ?? cache.sourceVersion,
    supports: (auction) => auction.country === 'fr',
    async compare(auction) {
      const candidates = candidateDvfTransactionsForAuction(auction, cache, options)
      return buildDvfMarketComparison(auction, candidates, options)
    },
  }
}

function marketClassForAuction(auction: Auction): MarketComparisonPropertyClass {
  const propertyType = auction.extraction?.propertyType
  if (
    propertyType === 'einfamilienhaus' ||
    propertyType === 'zweifamilienhaus' ||
    propertyType === 'mehrfamilienhaus' ||
    propertyType === 'doppelhaushaelfte' ||
    propertyType === 'reihenhaus'
  ) return 'house'
  if (propertyType === 'eigentumswohnung') return 'apartment'
  if (propertyType === 'land-forst' || propertyType === 'unbebaut') return 'land'
  if (propertyType === 'wohn-geschaefts') return 'mixed'
  return 'unknown'
}

function parseDelimitedRows(content: string): RawDvfRow[] {
  const cleaned = content.replace(/^\uFEFF/, '').trim()
  if (!cleaned) return []
  const delimiter = detectDelimiter(cleaned)
  const records = parseRecords(cleaned, delimiter)
  const header = records[0]?.map((value) => value.trim()) ?? []
  if (header.length === 0) return []

  return records.slice(1)
    .filter((record) => record.some((value) => value.trim()))
    .map((record) => {
      const row: Record<string, string> = {}
      for (const [index, key] of header.entries()) row[key] = record[index] ?? ''
      return row
    })
}

function detectDelimiter(content: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? ''
  const candidates = [';', ',', '\t']
  return candidates
    .map((delimiter) => ({ delimiter, count: firstLine.split(delimiter).length }))
    .sort((a, b) => b.count - a.count)[0]?.delimiter ?? ';'
}

function parseRecords(content: string, delimiter: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < content.length; i++) {
    const char = content[i]
    const next = content[i + 1]
    if (char === '"') {
      if (quoted && next === '"') {
        field += '"'
        i++
      } else {
        quoted = !quoted
      }
      continue
    }
    if (!quoted && char === delimiter) {
      record.push(field)
      field = ''
      continue
    }
    if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && next === '\n') i++
      record.push(field)
      records.push(record)
      record = []
      field = ''
      continue
    }
    field += char
  }

  record.push(field)
  records.push(record)
  return records
}
