import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/node-postgres'
import { getDb } from './db'

vi.mock('./db', () => ({ getDb: vi.fn() }))

// Imported after the mock so the module under test picks up the mocked getDb.
const { archiveDetailCapture, fetchTextAndArchive } = await import('./fetch-archive')

const IDENTITY = { platform: 'test', country: 'de', externalId: '1' }

interface FakeBlobRow {
  content_type: string
}

function queryText(queryArg: unknown): string {
  return typeof queryArg === 'string' ? queryArg : (queryArg as { text: string }).text
}

function makeFakePool() {
  const blobs = new Map<string, FakeBlobRow>()
  const captures: { kind: string; sourceUrl: string | null }[] = []

  const query = vi.fn(async (queryArg: unknown, params: unknown[] = []) => {
    const text = queryText(queryArg)
    const n = text.replace(/\s+/g, ' ').trim().toLowerCase()
    if (n.startsWith('select "uploaded_at" from "artifact_blobs"')) {
      const hash = params[0] as string
      return { rows: blobs.has(hash) ? [[null]] : [] }
    }
    if (n.startsWith('insert into "artifact_blobs"')) {
      const [hash, , content_type] = params as [string, string, string]
      if (!blobs.has(hash)) blobs.set(hash, { content_type })
      return { rows: [], rowCount: 1 }
    }
    if (n.includes('insert into artifact_captures')) {
      const [, kind, , , , sourceUrl] = params as [
        string,
        string,
        string,
        string,
        string,
        string | null,
      ]
      captures.push({ kind, sourceUrl })
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected query: ${text}`)
  })

  return { blobs, captures, query, db: drizzle({ query } as never) }
}

describe('archiveDetailCapture', () => {
  let outboxDir: string

  beforeEach(async () => {
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    outboxDir = await mkdtemp(join(tmpdir(), 'fetch-archive-test-'))
    vi.stubGlobal('useRuntimeConfig', () => ({ rawOutboxDir: outboxDir }))
  })

  afterEach(async () => {
    const { rm } = await import('node:fs/promises')
    vi.unstubAllGlobals()
    await rm(outboxDir, { recursive: true, force: true })
  })

  it('archives html bytes as kind=detail_html with the given source URL', async () => {
    const pool = makeFakePool()
    vi.mocked(getDb).mockReturnValue(pool.db as never)

    await archiveDetailCapture(
      Buffer.from('<html>lot detail</html>'),
      IDENTITY,
      'https://example.test/lot/1',
      '2026-07-19T00:00:00.000Z',
    )

    expect(pool.blobs.size).toBe(1)
    expect([...pool.blobs.values()][0]!.content_type).toBe('text/html+gzip')
    expect(pool.captures).toHaveLength(1)
    expect(pool.captures[0]).toEqual({ kind: 'detail_html', sourceUrl: 'https://example.test/lot/1' })
  })

  it('accepts a non-html contentType for a future non-HTML detail source', async () => {
    const pool = makeFakePool()
    vi.mocked(getDb).mockReturnValue(pool.db as never)

    await archiveDetailCapture(
      Buffer.from('%PDF-1.4 detail export'),
      IDENTITY,
      'https://example.test/lot/1.pdf',
      '2026-07-19T00:00:00.000Z',
      'application/pdf',
    )

    expect([...pool.blobs.values()][0]!.content_type).toBe('application/pdf')
  })

  it('no-ops without a DB pool', async () => {
    vi.mocked(getDb).mockReturnValue(null)
    await expect(
      archiveDetailCapture(Buffer.from('<html/>'), IDENTITY, 'https://example.test/lot/1', '2026-07-19T00:00:00.000Z'),
    ).resolves.toBeUndefined()
  })
})

describe('fetchTextAndArchive', () => {
  let outboxDir: string
  const originalFetch = global.fetch

  beforeEach(async () => {
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    outboxDir = await mkdtemp(join(tmpdir(), 'fetch-archive-test-'))
    vi.stubGlobal('useRuntimeConfig', () => ({ rawOutboxDir: outboxDir }))
  })

  afterEach(async () => {
    const { rm } = await import('node:fs/promises')
    vi.unstubAllGlobals()
    global.fetch = originalFetch
    await rm(outboxDir, { recursive: true, force: true })
  })

  it('returns the fetched text and archives it', async () => {
    const pool = makeFakePool()
    vi.mocked(getDb).mockReturnValue(pool.db as never)
    global.fetch = vi.fn(async () => new Response('<html>lot</html>', { status: 200 })) as never

    const text = await fetchTextAndArchive(
      'https://example.test/lot/1',
      IDENTITY,
      '2026-07-19T00:00:00.000Z',
    )

    expect(text).toBe('<html>lot</html>')
    expect(pool.captures).toHaveLength(1)
  })

  it('returns null and archives nothing on a non-2xx response', async () => {
    const pool = makeFakePool()
    vi.mocked(getDb).mockReturnValue(pool.db as never)
    global.fetch = vi.fn(async () => new Response('nope', { status: 404 })) as never

    const text = await fetchTextAndArchive(
      'https://example.test/lot/1',
      IDENTITY,
      '2026-07-19T00:00:00.000Z',
    )

    expect(text).toBeNull()
    expect(pool.captures).toHaveLength(0)
  })

  it('returns null on a network error', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network down')
    }) as never

    const text = await fetchTextAndArchive(
      'https://example.test/lot/1',
      IDENTITY,
      '2026-07-19T00:00:00.000Z',
    )

    expect(text).toBeNull()
  })
})
