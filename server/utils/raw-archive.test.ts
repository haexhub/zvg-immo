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
  archiveDocument,
  archiveDocumentSet,
  archiveDocumentText,
  archivePhotoBlob,
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
  uploaded_at: string | null
}

interface FakeCaptureRow {
  capturedAt: string
  contentHash: string
  sourceUrl: string | null
}

/** Minimal in-memory stand-in for the `pg` Pool, matching the exact queries
 *  raw-archive.ts issues (checked via the SQL prefix). Models the current
 *  archive uniqueness: auctions by identity+contentHash (append-only),
 *  documents/detail captures by identity+sourceUrl+contentHash. */
function makeFakePool() {
  const blobs = new Map<string, FakeBlobRow>()
  const captures = new Map<string, FakeCaptureRow>()
  const documentSets = new Map<string, { id: string; version: number; setHash: string }>()
  const documentSetItems = new Map<string, unknown[]>()

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [], rowCount: null }
    }
    if (sql.includes('SELECT uploaded_at FROM artifact_blobs')) {
      const hash = params[0] as string
      const row = blobs.get(hash)
      return { rows: row ? [{ uploaded_at: row.uploaded_at }] : [], rowCount: row ? 1 : 0 }
    }
    if (sql.includes('INSERT INTO artifact_blobs')) {
      const [hash, s3_key, content_type, byte_size] = params as [string, string, string, number]
      // Mirrors the production ON CONFLICT (content_hash) DO UPDATE SET
      // uploaded_at = null: a re-write always resets uploaded_at, whether
      // the row is new or a previously-orphaned one being recovered.
      blobs.set(hash, { s3_key, content_type, byte_size, uploaded_at: null })
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO artifact_captures')) {
      const [capturedAt, kind, platform, externalId, contentHash, sourceUrl] = params as [
        string,
        string,
        string,
        string,
        string,
        string | null,
      ]
      const key =
        kind === 'auction'
          ? `${kind}|${platform}|${externalId}|${contentHash}`
          : `${kind}|${platform}|${externalId}|${sourceUrl ?? ''}|${contentHash}`
      captures.set(key, { capturedAt, contentHash, sourceUrl })
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('SELECT id, version') && sql.includes('FROM artifact_versions')) {
      const [platform, externalId, setHash] = params as [string, string, string]
      const row = documentSets.get(`${platform}|${externalId}|${setHash}`)
      return { rows: row ? [{ id: row.id, version: row.version }] : [], rowCount: row ? 1 : 0 }
    }
    if (sql.includes('UPDATE artifact_versions')) {
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO artifact_versions')) {
      const [, platform, externalId, setHash] = params as [string, string, string, string, number]
      const identityPrefix = `${platform}|${externalId}|`
      const version = [...documentSets.keys()].filter((key) => key.startsWith(identityPrefix)).length + 1
      const id = String(documentSets.size + 1)
      documentSets.set(`${platform}|${externalId}|${setHash}`, { id, version, setHash })
      return { rows: [{ id, version }], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO artifact_version_items')) {
      documentSetItems.set(String(params[0]), params)
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected query: ${sql}`)
  })

  const connect = vi.fn(async () => ({ query, release: vi.fn() }))

  return { blobs, captures, documentSets, documentSetItems, query, connect }
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
  it('gzips json/html but not pdf/docx, and shards by the first two hex chars under a country folder', () => {
    const hash = 'ab'.padEnd(64, '0')
    expect(shardedKey(hash, 'application/json', 'de')).toBe(`Deutschland/ab/${hash}.json.gz`)
    expect(shardedKey(hash, 'text/html', 'de')).toBe(`Deutschland/ab/${hash}.html.gz`)
    expect(shardedKey(hash, 'application/pdf', 'de')).toBe(`Deutschland/ab/${hash}.pdf`)
    expect(shardedKey(hash, 'application/vnd.docx', 'de')).toBe(`Deutschland/ab/${hash}.docx`)
  })

  it('falls back to the uppercased code for an unmapped country', () => {
    const hash = 'cd'.padEnd(64, '0')
    expect(shardedKey(hash, 'application/pdf', 'xx')).toBe(`XX/cd/${hash}.pdf`)
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
    const hash = await archiveBlob(Buffer.from('{}'), 'application/json', 'de')
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

  it('archiveBlob dedups a *confirmed-uploaded* blob (no rewrite)', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    const bytes = Buffer.from(JSON.stringify({ a: 1 }))
    const first = await archiveBlob(bytes, 'application/json', 'de')
    pool.blobs.get(first!)!.uploaded_at = new Date().toISOString() // drainOutbox confirmed it

    const second = await archiveBlob(bytes, 'application/json', 'de')

    expect(second).toBe(first)
    expect(pool.blobs.size).toBe(1)
    // The confirmed-upload check short-circuits the second call — no redundant write.
    const insertCalls = pool.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO artifact_blobs'))
    expect(insertCalls).toHaveLength(1)
  })

  it('archiveBlob rewrites a still-pending (uploaded_at null) blob instead of trusting row presence', async () => {
    // Guards the ansible#62/zvg-immo#122 orphan scenario: a row can exist
    // with uploaded_at still null (e.g. drainOutbox never got to it, or a
    // historical outage falsely marked-then-lost it — see the comment in
    // archiveBlob). Treating existence alone as "already archived" would
    // permanently skip writing the outbox file, so any future capture
    // hash-matching that row would never actually be retrievable.
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    const bytes = Buffer.from(JSON.stringify({ a: 1 }))
    const first = await archiveBlob(bytes, 'application/json', 'de')
    const second = await archiveBlob(bytes, 'application/json', 'de')

    expect(second).toBe(first)
    expect(pool.blobs.size).toBe(1)
    const insertCalls = pool.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO artifact_blobs'))
    expect(insertCalls).toHaveLength(2)
    // The outbox file is present and intact either way.
    const row = pool.blobs.get(first!)!
    const stored = await readFile(join(outboxDir, row.s3_key))
    expect(gunzipSync(stored)).toEqual(bytes)
  })

  it('archiveBlob gzips JSON content in the outbox', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    const original = Buffer.from(JSON.stringify({ hello: 'world' }))
    const hash = await archiveBlob(original, 'application/json', 'de')
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

    // Both calls upsert (no fast-path skip) but land on the same row — the
    // unique index, not a pre-check, is what prevents a duplicate.
    expect(pool.captures.size).toBe(1)
    expect(pool.captures.get('auction|test|1|hash-a')).toMatchObject({ capturedAt: '2026-07-20T00:00:00.000Z' })
  })

  it('recordCapture refreshes metadata even when the content_hash is unchanged', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    const base = {
      kind: 'document' as const,
      platform: 'test',
      country: 'de',
      externalId: '1',
      contentHash: 'hash-a',
    }
    // The PDF itself never changes — it is simply re-seen on a later run.
    await recordCapture({ ...base, capturedAt: '2026-07-01T00:00:00.000Z' })
    await recordCapture({ ...base, capturedAt: '2026-07-20T00:00:00.000Z' })

    expect(pool.captures.size).toBe(1) // no duplicate row
    expect(pool.captures.get('document|test|1||hash-a')).toMatchObject({ capturedAt: '2026-07-20T00:00:00.000Z' })
  })

  it('recordCapture keeps separate document source URLs for the same auction', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    const base = {
      kind: 'document' as const,
      platform: 'test',
      country: 'de',
      externalId: '1',
      contentHash: 'hash-a',
    }
    await recordCapture({
      ...base,
      capturedAt: '2026-07-19T00:00:00.000Z',
      sourceUrl: 'https://example.test/appraisal.pdf',
    })
    await recordCapture({
      ...base,
      capturedAt: '2026-07-19T00:01:00.000Z',
      sourceUrl: 'https://example.test/notice.pdf',
    })

    expect(pool.captures.size).toBe(2)
    expect(pool.captures.has('document|test|1|https://example.test/appraisal.pdf|hash-a')).toBe(true)
    expect(pool.captures.has('document|test|1|https://example.test/notice.pdf|hash-a')).toBe(true)
  })

  it('recordCapture appends a new version when the content_hash changes', async () => {
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

    expect(pool.captures.size).toBe(2)
    expect(pool.captures.get('auction|test|1|hash-a')).toMatchObject({
      contentHash: 'hash-a',
      capturedAt: '2026-07-19T00:00:00.000Z',
    })
    expect(pool.captures.get('auction|test|1|hash-b')).toMatchObject({
      contentHash: 'hash-b',
      capturedAt: '2026-07-20T00:00:00.000Z',
    })
  })

  it('recordCapture preserves updated document content while deduping repeated hashes', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    const base = {
      kind: 'document' as const,
      platform: 'test',
      country: 'de',
      externalId: '1',
    }
    await recordCapture({
      ...base,
      capturedAt: '2026-07-01T00:00:00.000Z',
      contentHash: 'hash-a',
    })
    // …content genuinely changes for a while…
    await recordCapture({
      ...base,
      capturedAt: '2026-07-10T00:00:00.000Z',
      contentHash: 'hash-b',
    })
    // …then reverts to the original bytes. The logical document slot is
    // updated in place instead of preserving all intermediate captures.
    await recordCapture({
      ...base,
      capturedAt: '2026-07-20T00:00:00.000Z',
      contentHash: 'hash-a',
    })

    expect(pool.captures.size).toBe(2)
    expect(pool.captures.get('document|test|1||hash-a')).toMatchObject({
      contentHash: 'hash-a',
      capturedAt: '2026-07-20T00:00:00.000Z',
    })
    expect(pool.captures.get('document|test|1||hash-b')).toMatchObject({ contentHash: 'hash-b' })
  })

  it('archiveAuction: a second run with no real change produces no new blob or capture row', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    await archiveAuction(auction({ detailFetchedAt: '2026-07-19T00:00:00.000Z' }), '2026-07-19T00:00:00.000Z')
    await archiveAuction(auction({ detailFetchedAt: '2026-07-20T12:00:00.000Z' }), '2026-07-20T12:00:00.000Z')

    expect(pool.blobs.size).toBe(1)
    expect(pool.captures.size).toBe(1)
    const [hash] = pool.blobs.keys()
    expect(pool.captures.get(`auction|test|42|${hash}`)).toMatchObject({
      capturedAt: '2026-07-20T12:00:00.000Z',
    })
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
    expect(pool.captures.size).toBe(2) // new content_hash, new version appended
    const [firstHash, secondHash] = pool.blobs.keys()
    expect(pool.captures.get(`auction|test|42|${firstHash}`)).toMatchObject({
      contentHash: firstHash,
      capturedAt: '2026-07-19T00:00:00.000Z',
    })
    expect(pool.captures.get(`auction|test|42|${secondHash}`)).toMatchObject({
      contentHash: secondHash,
      capturedAt: '2026-07-19T00:05:00.000Z',
    })
    const captureInserts = pool.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO artifact_captures'))
    expect(captureInserts).toHaveLength(2)
  })

  it('archiveAuction stores identity by (platform, external_id) only, not denormalized columns', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    await archiveAuction(auction({ region: 'Sachsen-Anhalt' }), '2026-07-19T00:00:00.000Z')

    const [insertSql, insertParams] = pool.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO artifact_captures'),
    )!
    for (const column of ['country', 'region', 'case_number', 'authority']) {
      expect(insertSql).not.toContain(column)
    }
    expect(insertParams![2]).toBe('test') // platform
    expect(insertParams![3]).toBe('42') // external_id
  })

  it('archiveDocument: same PDF referenced by two auctions dedups the blob but captures both', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    const pdfBytes = Buffer.from('%PDF-1.4 fake appraisal bytes')
    await archiveDocument(
      pdfBytes,
      'application/pdf',
      {
        platform: 'test',
        country: 'de',
        region: 'Sachsen',
        externalId: '1',
        caseNumber: '1 K 1/26',
        authority: 'AG Test',
      },
      'https://example.test/appraisal.pdf',
      '2026-07-19T00:00:00.000Z',
    )
    await archiveDocument(
      pdfBytes,
      'application/pdf',
      { platform: 'test', country: 'de', externalId: '2' },
      'https://example.test/appraisal.pdf',
      '2026-07-19T00:05:00.000Z',
    )

    expect(pool.blobs.size).toBe(1) // hash-dedup: identical PDF bytes, one blob
    expect(pool.captures.size).toBe(2) // two distinct auctions, two capture rows
    const row = [...pool.blobs.values()][0]!
    expect(row.content_type).toBe('application/pdf') // raw, not gzipped

    const captureInserts = pool.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO artifact_captures'))
    expect(captureInserts).toHaveLength(2)
    expect(captureInserts[0]![1]).toContain('document')
    expect(captureInserts[0]![1]![3]).toBe('1') // external_id
    expect(captureInserts[1]![1]![3]).toBe('2')
  })

  it('archivePhotoBlob: roundtrips bytes into a photo capture without a sourceUrl', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    const photoBytes = Buffer.from('fake jpeg bytes')
    const hash = await archivePhotoBlob(
      photoBytes,
      'image/jpeg',
      { platform: 'test', country: 'de', region: 'Sachsen', externalId: '1', caseNumber: '1 K 1/26', authority: 'AG Test' },
      '2026-07-19T00:00:00.000Z',
    )

    expect(hash).toBe(sha256Hex(photoBytes))
    expect(pool.blobs.size).toBe(1)
    const row = [...pool.blobs.values()][0]!
    expect(row.content_type).toBe('image/jpeg') // raw, not gzipped
    const stored = await readFile(join(outboxDir, row.s3_key))
    expect(stored).toEqual(photoBytes)

    const captureInserts = pool.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO artifact_captures'))
    expect(captureInserts).toHaveLength(1)
    expect(captureInserts[0]![1]).toContain('photo')
    expect(captureInserts[0]![1]![5]).toBeNull() // no sourceUrl for photos
  })

  it('archivePhotoBlob: the same photo bytes referenced by two auctions dedup the blob but capture both', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    const photoBytes = Buffer.from('shared jpeg bytes')
    await archivePhotoBlob(photoBytes, 'image/jpeg', { platform: 'test', country: 'de', externalId: '1' }, '2026-07-19T00:00:00.000Z')
    await archivePhotoBlob(photoBytes, 'image/jpeg', { platform: 'test', country: 'de', externalId: '2' }, '2026-07-19T00:05:00.000Z')

    expect(pool.blobs.size).toBe(1)
    expect(pool.captures.size).toBe(2)
  })

  it('archivePhotoBlob no-ops without a DB pool', async () => {
    vi.mocked(getPool).mockReturnValue(null)
    await expect(
      archivePhotoBlob(
        Buffer.from('fake jpeg bytes'),
        'image/jpeg',
        { platform: 'test', country: 'de', externalId: '1' },
        '2026-07-19T00:00:00.000Z',
      ),
    ).resolves.toBeNull()
  })

  it('archiveDocumentText: gzips the text and records a document_text capture', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    await archiveDocumentText(
      'Gutachten-Volltext ...',
      { platform: 'test', country: 'de', externalId: '1' },
      'https://example.test/appraisal.pdf',
      '2026-07-19T00:00:00.000Z',
    )

    expect(pool.blobs.size).toBe(1)
    const row = [...pool.blobs.values()][0]!
    expect(row.content_type).toBe('text/plain+gzip')
    const stored = await readFile(join(outboxDir, row.s3_key))
    expect(gunzipSync(stored).toString('utf8')).toBe('Gutachten-Volltext ...')

    const captureInserts = pool.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO artifact_captures'))
    expect(captureInserts).toHaveLength(1)
    expect(captureInserts[0]![1]).toContain('document_text')
  })

  it('archiveDocumentSet reuses the same version for an unchanged document set', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    const identity = { platform: 'test', country: 'de', externalId: '1' }
    const documents = [
      {
        ordinal: 0,
        kind: 'document' as const,
        label: 'Gutachten',
        filename: 'gutachten.pdf',
        fileId: 'a',
        sourceUrl: 'https://example.test/gutachten.pdf',
        contentHash: 'hash-a',
        contentType: 'application/pdf' as const,
      },
    ]

    const first = await archiveDocumentSet(identity, documents, '2026-07-19T00:00:00.000Z')
    const second = await archiveDocumentSet(identity, documents, '2026-07-20T00:00:00.000Z')

    expect(first).toMatchObject({ version: 1, changed: true })
    expect(second).toMatchObject({ version: 1, changed: false, setHash: first?.setHash })
    expect(pool.documentSets.size).toBe(1)
  })

  it('archiveDocumentSet treats pure document reordering as unchanged', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    const identity = { platform: 'test', country: 'de', externalId: '1' }
    const first = await archiveDocumentSet(
      identity,
      [
        {
          ordinal: 0,
          kind: 'document',
          label: 'Gutachten',
          filename: 'gutachten.pdf',
          fileId: 'a',
          sourceUrl: 'https://example.test/gutachten.pdf',
          contentHash: 'hash-a',
          contentType: 'application/pdf',
        },
        {
          ordinal: 1,
          kind: 'document',
          label: 'Nachtrag',
          filename: 'nachtrag.pdf',
          fileId: 'b',
          sourceUrl: 'https://example.test/nachtrag.pdf',
          contentHash: 'hash-b',
          contentType: 'application/pdf',
        },
      ],
      '2026-07-19T00:00:00.000Z',
    )
    const reordered = await archiveDocumentSet(
      identity,
      [
        {
          ordinal: 0,
          kind: 'document',
          label: 'Nachtrag',
          filename: 'nachtrag.pdf',
          fileId: 'b',
          sourceUrl: 'https://example.test/nachtrag.pdf',
          contentHash: 'hash-b',
          contentType: 'application/pdf',
        },
        {
          ordinal: 1,
          kind: 'document',
          label: 'Gutachten',
          filename: 'gutachten.pdf',
          fileId: 'a',
          sourceUrl: 'https://example.test/gutachten.pdf',
          contentHash: 'hash-a',
          contentType: 'application/pdf',
        },
      ],
      '2026-07-20T00:00:00.000Z',
    )

    expect(reordered).toMatchObject({ version: 1, changed: false, setHash: first?.setHash })
    expect(pool.documentSets.size).toBe(1)
  })

  it('archiveDocumentSet creates a new version when the valid document set changes', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    const identity = { platform: 'test', country: 'de', externalId: '1' }
    const first = await archiveDocumentSet(
      identity,
      [
        {
          ordinal: 0,
          kind: 'document',
          label: 'Gutachten',
          filename: 'gutachten.pdf',
          fileId: 'a',
          sourceUrl: 'https://example.test/gutachten.pdf',
          contentHash: 'hash-a',
          contentType: 'application/pdf',
        },
      ],
      '2026-07-19T00:00:00.000Z',
    )
    const second = await archiveDocumentSet(
      identity,
      [
        {
          ordinal: 0,
          kind: 'document',
          label: 'Gutachten',
          filename: 'gutachten.pdf',
          fileId: 'a',
          sourceUrl: 'https://example.test/gutachten.pdf',
          contentHash: 'hash-b',
          contentType: 'application/pdf',
        },
        {
          ordinal: 1,
          kind: 'document',
          label: 'Nachtrag',
          filename: 'nachtrag.pdf',
          fileId: 'b',
          sourceUrl: 'https://example.test/nachtrag.pdf',
          contentHash: 'hash-c',
          contentType: 'application/pdf',
        },
      ],
      '2026-07-20T00:00:00.000Z',
    )

    expect(first).toMatchObject({ version: 1 })
    expect(second).toMatchObject({ version: 2, changed: true })
    expect(second?.setHash).not.toBe(first?.setHash)
    expect(pool.documentSets.size).toBe(2)
    const itemParams = pool.documentSetItems.get('2')
    expect(itemParams).toBeDefined()
    expect([
      { ordinal: itemParams![1], contentHash: itemParams![7] },
      { ordinal: itemParams![10], contentHash: itemParams![16] },
    ]).toEqual([
      { ordinal: 0, contentHash: 'hash-b' },
      { ordinal: 1, contentHash: 'hash-c' },
    ])
  })

  it('archiveDocumentText no-ops without a DB pool', async () => {
    vi.mocked(getPool).mockReturnValue(null)
    await expect(
      archiveDocumentText(
        'text',
        { platform: 'test', country: 'de', externalId: '1' },
        'https://example.test/appraisal.pdf',
        '2026-07-19T00:00:00.000Z',
      ),
    ).resolves.toBeNull()
  })

  it('archiveDocument no-ops without a DB pool', async () => {
    vi.mocked(getPool).mockReturnValue(null)
    await expect(
      archiveDocument(
        Buffer.from('%PDF-1.4'),
        'application/pdf',
        { platform: 'test', country: 'de', externalId: '1' },
        'https://example.test/appraisal.pdf',
        '2026-07-19T00:00:00.000Z',
      ),
    ).resolves.toBeNull()
  })
})
