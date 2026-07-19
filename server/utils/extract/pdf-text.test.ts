import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPool } from '../db'

vi.mock('../db', () => ({ getPool: vi.fn() }))

// Imported after the mock so the module under test picks up the mocked getPool.
const { pdfToText } = await import('./pdf-text')

const CACHE_DIR = join(process.cwd(), '.cache_zvg', 'pdftext')
const FAKE_PDF = Buffer.from('%PDF-1.4\n%%EOF')

async function cleanupTextCache(url: string): Promise<void> {
  const key = createHash('sha1').update(url).digest('hex')
  await rm(join(CACHE_DIR, `${key}.txt`), { force: true })
}

interface FakeBlobRow {
  s3_key: string
  content_type: string
}

/** Minimal in-memory stand-in for the `pg` Pool, matching raw-archive.ts's queries. */
function makeFakePool() {
  const blobs = new Map<string, FakeBlobRow>()
  const captures: Array<{ kind: string; platform: string; externalId: string; sourceUrl: string | null }> = []

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT 1 FROM raw_blobs')) {
      const hash = params[0] as string
      return { rows: [], rowCount: blobs.has(hash) ? 1 : 0 }
    }
    if (sql.includes('INSERT INTO raw_blobs')) {
      const [hash, s3_key, content_type] = params as [string, string, string]
      if (!blobs.has(hash)) blobs.set(hash, { s3_key, content_type })
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('SELECT content_hash FROM raw_captures')) {
      return { rows: [] }
    }
    if (sql.includes('INSERT INTO raw_captures')) {
      const [, kind, platform, , externalId, , , , sourceUrl] = params as [
        string, string, string, string, string, string | null, string | null, string, string | null,
      ]
      captures.push({ kind, platform, externalId, sourceUrl })
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected query: ${sql}`)
  })

  return { blobs, captures, query }
}

describe('pdfToText document archiving', () => {
  let outboxDir: string

  beforeEach(async () => {
    outboxDir = await mkdtemp(join(tmpdir(), 'pdf-text-archive-test-'))
    vi.stubGlobal('useRuntimeConfig', () => ({ rawOutboxDir: outboxDir }))
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(FAKE_PDF, { status: 200 })))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(outboxDir, { recursive: true, force: true })
  })

  it('archives the fetched PDF as a document capture when identity is passed', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    const url = 'https://example.test/appraisal-a.pdf'
    await cleanupTextCache(url)

    await pdfToText(url, {
      identity: { platform: 'de', country: 'de', externalId: '1' },
      capturedAt: '2026-07-19T00:00:00.000Z',
    })

    expect(pool.blobs.size).toBe(1)
    expect(pool.captures).toHaveLength(1)
    expect(pool.captures[0]).toMatchObject({ kind: 'document', platform: 'de', externalId: '1', sourceUrl: url })
    expect([...pool.blobs.values()][0]!.content_type).toBe('application/pdf')

    await cleanupTextCache(url)
  })

  it('does not archive when no identity is passed (e.g. the pdf-thumb path)', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    const url = 'https://example.test/appraisal-b.pdf'
    await cleanupTextCache(url)

    await pdfToText(url)

    expect(pool.blobs.size).toBe(0)
    expect(pool.captures).toHaveLength(0)

    await cleanupTextCache(url)
  })

  it('dedups the same PDF fetched for two different auctions (one blob, two captures)', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    const urlA = 'https://example.test/shared.pdf?a'
    const urlB = 'https://example.test/shared.pdf?b'
    await cleanupTextCache(urlA)
    await cleanupTextCache(urlB)

    await pdfToText(urlA, {
      identity: { platform: 'de', country: 'de', externalId: '1' },
      capturedAt: '2026-07-19T00:00:00.000Z',
    })
    await pdfToText(urlB, {
      identity: { platform: 'de', country: 'de', externalId: '2' },
      capturedAt: '2026-07-19T00:00:00.000Z',
    })

    expect(pool.blobs.size).toBe(1)
    expect(pool.captures).toHaveLength(2)

    await cleanupTextCache(urlA)
    await cleanupTextCache(urlB)
  })
})
