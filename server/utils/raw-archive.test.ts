import { gunzipSync } from 'node:zlib'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import { getPool } from './db'

vi.mock('./db', () => ({ getPool: vi.fn() }))

// Imported after the mock so the module under test picks up the mocked getPool.
const {
  archiveAuction,
  archiveBlob,
  canonicalizeAuction,
  recordCapture,
  sha256Hex,
  shardedKey,
} = await import('./raw-archive')

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'test',
    country: 'de',
    region: 'Sachsen',
    externalId: '42',
    caseNumber: '1 K 1/26',
    authority: 'AG Test',
    title: 'Einfamilienhaus',
    address: null,
    marketValueEur: 250000,
    marketValueText: null,
    auctionDateIso: '2026-08-01T09:00:00.000Z',
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
    ...overrides,
  }
}

interface FakeBlobRow {
  s3_key: string
  content_type: string
  byte_size: number
}

/** Minimal in-memory stand-in for the `pg` Pool, matching the exact queries
 *  raw-archive.ts issues (checked via the SQL prefix). */
function makeFakePool() {
  const blobs = new Map<string, FakeBlobRow>()
  const captures = new Map<string, { content_hash: string }>()

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT 1 FROM raw_blobs')) {
      const hash = params[0] as string
      return { rows: [], rowCount: blobs.has(hash) ? 1 : 0 }
    }
    if (sql.includes('INSERT INTO raw_blobs')) {
      const [hash, s3_key, content_type, byte_size] = params as [string, string, string, number]
      if (!blobs.has(hash)) blobs.set(hash, { s3_key, content_type, byte_size })
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('SELECT content_hash FROM raw_captures')) {
      const [kind, platform, externalId] = params as [string, string, string]
      const hit = captures.get(`${kind}|${platform}|${externalId}`)
      return { rows: hit ? [hit] : [] }
    }
    if (sql.includes('INSERT INTO raw_captures')) {
      const [, kind, platform, , externalId, , , contentHash] = params as [
        string,
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string,
      ]
      captures.set(`${kind}|${platform}|${externalId}`, { content_hash: contentHash })
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected query: ${sql}`)
  })

  return { blobs, captures, query }
}

describe('canonicalizeAuction', () => {
  it('strips detailFetchedAt and extraction, and sorts keys', () => {
    const a = canonicalizeAuction(auction({ detailFetchedAt: '2026-07-19T00:00:00.000Z' }))
    const b = canonicalizeAuction(auction({ detailFetchedAt: '2099-01-01T00:00:00.000Z' }))
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('is stable regardless of source key order', () => {
    const base = auction()
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as unknown as Auction
    expect(JSON.stringify(canonicalizeAuction(base))).toBe(
      JSON.stringify(canonicalizeAuction(reordered)),
    )
  })

  it('reflects a real content change', () => {
    const a = canonicalizeAuction(auction({ description: 'Altbau, saniert' }))
    const b = canonicalizeAuction(auction({ description: null }))
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
  })

  it('ignores marketValueEur FX drift (same source value, different EUR)', () => {
    // deriveMarketValueEur recomputes marketValueEur from live ECB rates every
    // run, so a non-EUR auction's EUR figure moves daily even when the source
    // price is unchanged. The canonical form must key on marketValue+currency.
    const a = canonicalizeAuction(
      auction({ marketValue: 100000, currency: 'GBP', marketValueEur: 118000 }),
    )
    const b = canonicalizeAuction(
      auction({ marketValue: 100000, currency: 'GBP', marketValueEur: 119500 }),
    )
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('still detects a real price change (marketValue differs)', () => {
    const a = canonicalizeAuction(auction({ marketValue: 100000, currency: 'GBP' }))
    const b = canonicalizeAuction(auction({ marketValue: 120000, currency: 'GBP' }))
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
  })
})

describe('sha256Hex', () => {
  it('is deterministic for identical bytes', () => {
    const bytes = Buffer.from('hello world')
    expect(sha256Hex(bytes)).toBe(sha256Hex(Buffer.from('hello world')))
  })

  it('differs for different bytes', () => {
    expect(sha256Hex(Buffer.from('a'))).not.toBe(sha256Hex(Buffer.from('b')))
  })
})

describe('shardedKey', () => {
  it('gzips json/html but not pdf/docx, and shards by the first two hex chars', () => {
    const hash = 'ab'.padEnd(64, '0')
    expect(shardedKey(hash, 'application/json')).toBe(`ab/${hash}.json.gz`)
    expect(shardedKey(hash, 'text/html')).toBe(`ab/${hash}.html.gz`)
    expect(shardedKey(hash, 'application/pdf')).toBe(`ab/${hash}.pdf`)
    expect(shardedKey(hash, 'application/vnd.docx')).toBe(`ab/${hash}.docx`)
  })
})

describe('archiveBlob / recordCapture / archiveAuction (DB mocked)', () => {
  let outboxDir: string

  beforeEach(async () => {
    outboxDir = await mkdtemp(join(tmpdir(), 'raw-archive-test-'))
    vi.stubGlobal('useRuntimeConfig', () => ({ rawOutboxDir: outboxDir }))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(outboxDir, { recursive: true, force: true })
  })

  it('archiveBlob no-ops without a DB pool', async () => {
    vi.mocked(getPool).mockReturnValue(null)
    const hash = await archiveBlob(Buffer.from('{}'), 'application/json')
    expect(hash).toBeNull()
  })

  it('recordCapture no-ops without a DB pool', async () => {
    vi.mocked(getPool).mockReturnValue(null)
    await expect(
      recordCapture({
        capturedAt: '2026-07-19T00:00:00.000Z',
        kind: 'auction',
        platform: 'test',
        country: 'de',
        externalId: '1',
        contentHash: 'x',
      }),
    ).resolves.toBeUndefined()
  })

  it('archiveBlob dedups identical content (one outbox write, one DB row)', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    const bytes = Buffer.from(JSON.stringify({ a: 1 }))
    const first = await archiveBlob(bytes, 'application/json')
    const second = await archiveBlob(bytes, 'application/json')

    expect(first).not.toBeNull()
    expect(second).toBe(first)
    expect(pool.blobs.size).toBe(1)
    // The existence check short-circuits the second call — no redundant write.
    const insertCalls = pool.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO raw_blobs'))
    expect(insertCalls).toHaveLength(1)
  })

  it('archiveBlob gzips JSON content in the outbox', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    const original = Buffer.from(JSON.stringify({ hello: 'world' }))
    const hash = await archiveBlob(original, 'application/json')
    const row = pool.blobs.get(hash!)!
    const stored = await readFile(join(outboxDir, row.s3_key))
    expect(gunzipSync(stored)).toEqual(original)
    expect(row.content_type).toBe('application/json+gzip')
  })

  it('recordCapture is change-only: identical content_hash inserts nothing new', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    const base = {
      kind: 'auction' as const,
      platform: 'test',
      country: 'de',
      externalId: '1',
      contentHash: 'hash-a',
    }
    await recordCapture({ ...base, capturedAt: '2026-07-19T00:00:00.000Z' })
    await recordCapture({ ...base, capturedAt: '2026-07-20T00:00:00.000Z' })

    const insertCalls = pool.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO raw_captures'))
    expect(insertCalls).toHaveLength(1)
  })

  it('recordCapture inserts again when the content_hash changes', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    const base = {
      kind: 'auction' as const,
      platform: 'test',
      country: 'de',
      externalId: '1',
    }
    await recordCapture({ ...base, capturedAt: '2026-07-19T00:00:00.000Z', contentHash: 'hash-a' })
    await recordCapture({ ...base, capturedAt: '2026-07-20T00:00:00.000Z', contentHash: 'hash-b' })

    const insertCalls = pool.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO raw_captures'))
    expect(insertCalls).toHaveLength(2)
  })

  it('archiveAuction: a second run with no real change produces no new blob or capture', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    await archiveAuction(auction({ detailFetchedAt: '2026-07-19T00:00:00.000Z' }), '2026-07-19T00:00:00.000Z')
    await archiveAuction(auction({ detailFetchedAt: '2026-07-20T12:00:00.000Z' }), '2026-07-20T12:00:00.000Z')

    expect(pool.blobs.size).toBe(1)
    expect(pool.captures.size).toBe(1)
    const captureInserts = pool.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO raw_captures'))
    expect(captureInserts).toHaveLength(1)
  })

  it('archiveAuction: enrichment (new description) produces a new blob and capture', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    await archiveAuction(auction(), '2026-07-19T00:00:00.000Z')
    await archiveAuction(
      auction({ description: 'Saniertes Einfamilienhaus', detailFetchedAt: '2026-07-19T00:00:00.000Z' }),
      '2026-07-19T00:05:00.000Z',
    )

    expect(pool.blobs.size).toBe(2)
    expect(pool.captures.size).toBe(1) // same identity, latest capture overwritten
    const captureInserts = pool.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO raw_captures'))
    expect(captureInserts).toHaveLength(2)
  })
})
