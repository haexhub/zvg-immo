import { createReadStream } from 'node:fs'
import type { Auction, MarketComparisonPropertyClass } from '~/types/auction'
import { readJsonCache, writeJsonCache } from '../json-cache'
import {
  buildDvfMarketComparison,
  DEFAULT_DVF_RADIUS_METERS,
  normalizeDvfMutation,
  type DvfMarketComparisonOptions,
  type DvfTransaction,
  type RawDvfRow,
} from './fr-dvf'
import { encodeGeohash, geohashesWithinRadius } from './geohash'
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
  /** CSV data rows read. */
  rows: number
  /** Mutations kept as transactions. */
  normalized: number
  /** Mutations dropped (no price/coordinates, mixed or unclassifiable). */
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

/**
 * Streams the CSV: a national DVF export is several hundred MB, and reading it
 * as one string plus every parsed record (~40 columns each) overflowed V8's
 * string limit or the container heap inside the Nitro process. Each row is now
 * normalized as soon as it is parsed, so only DvfTransactions stay resident.
 * ponytail: the transactions and the cache's JSON string are still held whole
 * (fine for one national year); a multi-year corpus needs a chunked cache
 * format and a detached import.
 */
export async function loadDvfCsvFile(path: string): Promise<DvfCsvLoadResult> {
  const loader = createDvfCsvLoader()
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) loader.write(chunk as string)
  return loader.end()
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
  const loader = createDvfCsvLoader()
  loader.write(content)
  return loader.end()
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
  options: { geohashPrefixLength?: number; radiusMeters?: number } = {},
): DvfTransaction[] {
  if (auction.lat == null || auction.lng == null) return []
  const propertyClass = marketClassForAuction(auction)
  const group = cache.groups[propertyClass]
  if (!group) return []
  // The comparison keeps every sale within the radius, so the candidates must
  // cover all cells the radius reaches, not only the auction's own cell.
  const geohashes = geohashesWithinRadius(
    auction.lat,
    auction.lng,
    options.radiusMeters ?? DEFAULT_DVF_RADIUS_METERS,
    options.geohashPrefixLength ?? DEFAULT_GEOHASH_PREFIX_LENGTH,
  )
  const indexes = geohashes.flatMap((geohash) => group.byGeohash[geohash] ?? [])
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

function createDvfCsvLoader(): { write: (chunk: string) => void; end: () => DvfCsvLoadResult } {
  const transactions: DvfTransaction[] = []
  let rows = 0
  let mutations = 0
  let header: string[] | null = null
  // DVF exports list a mutation's rows contiguously, so a mutation is complete
  // as soon as the id changes — only one mutation's rows are ever buffered.
  // Rows without an id_mutation are each their own mutation.
  let mutation: RawDvfRow[] = []
  const flushMutation = () => {
    if (mutation.length === 0) return
    mutations++
    const normalized = normalizeDvfMutation(mutation)
    if (normalized) transactions.push(normalized)
    mutation = []
  }
  const parser = createCsvRecordParser((record) => {
    if (!record.some((value) => value.trim())) return
    if (!header) {
      header = record.map((value) => value.trim())
      return
    }
    const row: Record<string, string> = {}
    for (const [index, key] of header.entries()) row[key] = record[index] ?? ''
    rows++
    if (!row.id_mutation || row.id_mutation !== mutation[0]?.id_mutation) flushMutation()
    mutation.push(row)
  })
  return {
    write: parser.write,
    end() {
      parser.end()
      flushMutation()
      return { rows, normalized: transactions.length, dropped: mutations - transactions.length, transactions }
    },
  }
}

function detectDelimiter(content: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? ''
  const candidates = [';', ',', '\t']
  return candidates
    .map((delimiter) => ({ delimiter, count: firstLine.split(delimiter).length }))
    .sort((a, b) => b.count - a.count)[0]?.delimiter ?? ';'
}

/** Incremental CSV record parser: chunks can split a line, a quoted field, a
 *  `""` escape or a CRLF anywhere, so all parser state survives between
 *  writes. */
function createCsvRecordParser(onRecord: (record: string[]) => void): { write: (chunk: string) => void; end: () => void } {
  let delimiter: string | null = null
  // Text not consumed yet: everything before the header line is complete (the
  // delimiter is detected from it), or a trailing `"`/`\r` whose meaning
  // depends on the next chunk's first character.
  let pending = ''
  let record: string[] = []
  let field = ''
  let quoted = false

  function consume(text: string, final: boolean): void {
    for (let i = 0; i < text.length; i++) {
      const char = text[i]
      if (!final && i === text.length - 1 && (char === '"' || char === '\r')) {
        pending = char
        return
      }
      const next = text[i + 1]
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
        onRecord(record)
        record = []
        field = ''
        continue
      }
      field += char
    }
  }

  function take(chunk: string): string {
    const text = pending + chunk
    pending = ''
    return delimiter == null ? text.replace(/^\uFEFF/, '') : text
  }

  return {
    write(chunk) {
      const text = take(chunk)
      if (delimiter == null) {
        if (!/[\r\n]/.test(text)) {
          pending = text
          return
        }
        delimiter = detectDelimiter(text.trimStart())
      }
      consume(text, false)
    },
    end() {
      const text = take('')
      delimiter ??= detectDelimiter(text.trimStart())
      consume(text, true)
      record.push(field)
      onRecord(record)
    },
  }
}
