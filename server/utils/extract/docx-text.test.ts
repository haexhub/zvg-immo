import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPool } from '../db'

vi.mock('../db', () => ({ getPool: vi.fn() }))

// Imported after the mock so the module under test picks up the mocked getPool.
const { docxBufferToText, docxToText } = await import('./docx-text')

function writeUInt16(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}

function writeUInt32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}

function zipWithDocumentXml(xml: string): Buffer {
  const name = Buffer.from('word/document.xml')
  const body = Buffer.from(xml)
  const compressed = deflateRawSync(body)
  const localHeader = Buffer.concat([
    writeUInt32(0x04034b50),
    writeUInt16(20),
    writeUInt16(0),
    writeUInt16(8),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt32(0),
    writeUInt32(compressed.length),
    writeUInt32(body.length),
    writeUInt16(name.length),
    writeUInt16(0),
    name,
  ])
  const local = Buffer.concat([localHeader, compressed])
  const central = Buffer.concat([
    writeUInt32(0x02014b50),
    writeUInt16(20),
    writeUInt16(20),
    writeUInt16(0),
    writeUInt16(8),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt32(0),
    writeUInt32(compressed.length),
    writeUInt32(body.length),
    writeUInt16(name.length),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt32(0),
    writeUInt32(0),
    name,
  ])
  const eocd = Buffer.concat([
    writeUInt32(0x06054b50),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(1),
    writeUInt16(1),
    writeUInt32(central.length),
    writeUInt32(local.length),
    writeUInt16(0),
  ])
  return Buffer.concat([local, central, eocd])
}

async function cleanup(url: string): Promise<void> {
  const key = createHash('sha1').update(url).digest('hex')
  await rm(join(process.cwd(), '.cache_zvg', 'docxtext', `${key}.txt`), { force: true })
}

function dataUrl(buf: Buffer): string {
  return `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${buf.toString('base64')}`
}

describe('docxToText', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('extracts word/document.xml text from a docx zip', async () => {
    const url = dataUrl(zipWithDocumentXml([
      '<w:document><w:body>',
      '<w:p><w:r><w:t>Price &amp; address</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>150.000 KM</w:t><w:tab/><w:t>KO Sarajevo</w:t></w:r></w:p>',
      '</w:body></w:document>',
    ].join('')))
    await cleanup(url)
    await expect(docxToText(url)).resolves.toBe('Price & address\n150.000 KM KO Sarajevo')
    await cleanup(url)
  })

  it('preserves explicit Word line breaks as newlines', async () => {
    const url = dataUrl(zipWithDocumentXml([
      '<w:document><w:body>',
      '<w:p><w:r><w:t>Address</w:t><w:br/><w:t>Second line</w:t></w:r></w:p>',
      '</w:body></w:document>',
    ].join('')))
    await cleanup(url)
    await expect(docxToText(url)).resolves.toBe('Address\nSecond line')
    await cleanup(url)
  })

  it('rejects responses with a content-length above the DOCX size cap', async () => {
    const url = 'https://example.test/too-large.docx'
    await cleanup(url)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { 'content-length': String(21 * 1024 * 1024) },
        }),
      ),
    )

    await expect(docxToText(url)).resolves.toBeNull()
    expect(fetch).toHaveBeenCalledOnce()
    await cleanup(url)
  })

  it('returns null for malformed docx content', async () => {
    const url = dataUrl(Buffer.from([0x50, 0x4b]))
    await cleanup(url)
    await expect(docxToText(url)).resolves.toBeNull()
    await cleanup(url)
  })

  it('rejects a highly compressed document.xml whose inflated size exceeds the cap', () => {
    const oversized = zipWithDocumentXml(`<w:document><w:body>${'x'.repeat(21 * 1024 * 1024)}</w:body></w:document>`)
    expect(oversized.length).toBeLessThan(200_000)
    expect(docxBufferToText(oversized)).toBeNull()
  })
})

interface FakeBlobRow {
  s3_key: string
  content_type: string
}

/** Minimal in-memory stand-in for the `pg` Pool, matching raw-archive.ts's queries. */
function makeFakePool() {
  const blobs = new Map<string, FakeBlobRow>()
  const captures: Array<{ kind: string; platform: string; externalId: string; sourceUrl: string | null }> = []

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT uploaded_at FROM artifact_blobs')) {
      const hash = params[0] as string
      return { rows: blobs.has(hash) ? [{ uploaded_at: null }] : [] }
    }
    if (sql.includes('INSERT INTO artifact_blobs')) {
      const [hash, s3_key, content_type] = params as [string, string, string]
      if (!blobs.has(hash)) blobs.set(hash, { s3_key, content_type })
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('SELECT content_hash FROM artifact_captures')) {
      return { rows: [] }
    }
    if (sql.includes('INSERT INTO artifact_captures')) {
      const [, kind, platform, externalId, , sourceUrl] = params as [
        string, string, string, string, string, string | null,
      ]
      captures.push({ kind, platform, externalId, sourceUrl })
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected query: ${sql}`)
  })

  return { blobs, captures, query }
}

describe('docxToText document archiving', () => {
  let outboxDir: string

  beforeEach(async () => {
    outboxDir = await mkdtemp(join(tmpdir(), 'docx-text-archive-test-'))
    vi.stubGlobal('useRuntimeConfig', () => ({ rawOutboxDir: outboxDir }))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(outboxDir, { recursive: true, force: true })
  })

  it('archives the fetched DOCX as a document capture when identity is passed', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    const url = dataUrl(zipWithDocumentXml('<w:document><w:body><w:p><w:r><w:t>Appraisal</w:t></w:r></w:p></w:body></w:document>'))
    await cleanup(url)

    await docxToText(url, {
      identity: { platform: 'ba', country: 'ba', externalId: '7' },
      capturedAt: '2026-07-19T00:00:00.000Z',
    })

    expect(pool.blobs.size).toBe(1)
    expect(pool.captures).toHaveLength(1)
    expect(pool.captures[0]).toMatchObject({ kind: 'document', platform: 'ba', externalId: '7', sourceUrl: url })
    expect([...pool.blobs.values()][0]!.content_type).toBe('application/vnd.docx')

    await cleanup(url)
  })

  it('does not archive when no identity is passed', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    const url = dataUrl(zipWithDocumentXml('<w:document><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>'))
    await cleanup(url)

    await docxToText(url)

    expect(pool.blobs.size).toBe(0)
    expect(pool.captures).toHaveLength(0)

    await cleanup(url)
  })

  it('dedups the same DOCX referenced by two auctions (one blob, two captures)', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    const xml = '<w:document><w:body><w:p><w:r><w:t>Shared appraisal</w:t></w:r></w:p></w:body></w:document>'
    const urlA = dataUrl(zipWithDocumentXml(xml))
    await cleanup(urlA)

    await docxToText(urlA, {
      identity: { platform: 'ba', country: 'ba', externalId: '1' },
      capturedAt: '2026-07-19T00:00:00.000Z',
    })
    // Re-fetch the identical bytes for a second auction — the text cache is
    // keyed by URL, so an identical-but-distinct URL is used to force a
    // second real fetch (and thus a second archive attempt) rather than
    // silently short-circuiting on the disk cache.
    const urlB = `${urlA}#dup`
    await cleanup(urlB)
    await docxToText(urlB, {
      identity: { platform: 'ba', country: 'ba', externalId: '2' },
      capturedAt: '2026-07-19T00:00:00.000Z',
    })

    expect(pool.blobs.size).toBe(1)
    expect(pool.captures).toHaveLength(2)

    await cleanup(urlA)
    await cleanup(urlB)
  })
})
