import { gzipSync } from 'node:zlib'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPool } from './db'
import { getServiceClient } from './supabase'

vi.mock('./db', () => ({ getPool: vi.fn() }))
vi.mock('./supabase', () => ({ getServiceClient: vi.fn() }))

const { findLatestCapture, downloadBlob } = await import('./storage-download')

function makeFakePool(overrides: {
  captures?: Array<{ content_hash: string; source_url: string | null; captured_at: string }>
  blobs?: Record<string, { s3_key: string; content_type: string }>
}) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM artifact_captures')) {
      const rows = overrides.captures ?? []
      if (sql.includes('AND source_url')) {
        const sourceUrl = params[3]
        return { rows: rows.filter((r) => r.source_url === sourceUrl) }
      }
      return { rows }
    }
    if (sql.includes('FROM artifact_blobs')) {
      const hash = params[0] as string
      const blob = overrides.blobs?.[hash]
      return { rows: blob ? [blob] : [] }
    }
    throw new Error(`unexpected query: ${sql}`)
  })
  return { query }
}

describe('findLatestCapture', () => {
  it('returns null without a DB pool', async () => {
    vi.mocked(getPool).mockReturnValue(null)
    expect(await findLatestCapture('auction', 'zvg-portal', '7265')).toBeNull()
  })

  it('returns the most recent capture row', async () => {
    const pool = makeFakePool({
      captures: [{ content_hash: 'abc123', source_url: 'https://example.test/x.pdf', captured_at: '2026-07-20T00:00:00.000Z' }],
    })
    vi.mocked(getPool).mockReturnValue(pool as never)
    const result = await findLatestCapture('auction', 'zvg-portal', '7265')
    expect(result).toEqual({
      contentHash: 'abc123',
      sourceUrl: 'https://example.test/x.pdf',
      capturedAt: '2026-07-20T00:00:00.000Z',
    })
  })

  it('narrows by sourceUrl when given', async () => {
    const pool = makeFakePool({
      captures: [
        { content_hash: 'wrong', source_url: 'https://example.test/other.pdf', captured_at: '2026-07-20T00:00:00.000Z' },
        { content_hash: 'right', source_url: 'https://example.test/wanted.pdf', captured_at: '2026-07-19T00:00:00.000Z' },
      ],
    })
    vi.mocked(getPool).mockReturnValue(pool as never)
    const result = await findLatestCapture('document', 'zvg-portal', '7265', 'https://example.test/wanted.pdf')
    expect(result?.contentHash).toBe('right')
  })

  it('returns null on query failure', async () => {
    vi.mocked(getPool).mockReturnValue({ query: vi.fn().mockRejectedValue(new Error('boom')) } as never)
    expect(await findLatestCapture('auction', 'zvg-portal', '7265')).toBeNull()
  })
})

describe('downloadBlob', () => {
  let outboxDir: string

  beforeEach(async () => {
    outboxDir = await mkdtemp(join(tmpdir(), 'storage-download-test-'))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(outboxDir, { recursive: true, force: true })
  })

  it('returns null without a DB pool', async () => {
    vi.mocked(getPool).mockReturnValue(null)
    expect(await downloadBlob('abc')).toBeNull()
  })

  it('returns null for an unknown content hash', async () => {
    vi.mocked(getPool).mockReturnValue(makeFakePool({}) as never)
    expect(await downloadBlob('nonexistent')).toBeNull()
  })

  it('reads plain (non-gzip) bytes from the local outbox', async () => {
    const key = 'Deutschland/ab/abcdef.pdf'
    const filePath = join(outboxDir, key)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, Buffer.from('%PDF-1.4 fake bytes'))

    vi.stubGlobal('useRuntimeConfig', () => ({ rawOutboxDir: outboxDir }))
    const pool = makeFakePool({ blobs: { abcdef: { s3_key: key, content_type: 'application/pdf' } } })
    vi.mocked(getPool).mockReturnValue(pool as never)

    const result = await downloadBlob('abcdef')
    expect(result?.toString()).toBe('%PDF-1.4 fake bytes')
  })

  it('gunzips text blobs read from the outbox', async () => {
    const key = 'Deutschland/cd/cdef01.json.gz'
    const filePath = join(outboxDir, key)
    await mkdir(dirname(filePath), { recursive: true })
    const original = JSON.stringify({ title: 'Einfamilienhaus' })
    await writeFile(filePath, gzipSync(Buffer.from(original)))

    vi.stubGlobal('useRuntimeConfig', () => ({ rawOutboxDir: outboxDir }))
    const pool = makeFakePool({ blobs: { cdef01: { s3_key: key, content_type: 'application/json+gzip' } } })
    vi.mocked(getPool).mockReturnValue(pool as never)

    const result = await downloadBlob('cdef01')
    expect(result?.toString()).toBe(original)
  })

  it('falls back to Supabase Storage when the outbox file is missing, gunzipping as needed', async () => {
    const key = 'Deutschland/ef/ef0123.json.gz'
    const original = JSON.stringify({ title: 'Mehrfamilienhaus' })
    const downloadMock = vi.fn(async () => ({
      data: { arrayBuffer: async () => gzipSync(Buffer.from(original)) },
      error: null,
    }))
    const fakeSupabase = { storage: { from: vi.fn(() => ({ download: downloadMock })) } }
    vi.mocked(getServiceClient).mockReturnValue(fakeSupabase as never)

    vi.stubGlobal('useRuntimeConfig', () => ({ rawOutboxDir: outboxDir, storageBucket: 'zvg-immo-raw-archive' }))
    const pool = makeFakePool({ blobs: { ef0123: { s3_key: key, content_type: 'application/json+gzip' } } })
    vi.mocked(getPool).mockReturnValue(pool as never)

    const result = await downloadBlob('ef0123')
    expect(result?.toString()).toBe(original)
    expect(fakeSupabase.storage.from).toHaveBeenCalledWith('zvg-immo-raw-archive')
    expect(downloadMock).toHaveBeenCalledWith(key, {}, { signal: expect.any(AbortSignal) })
  })

  it('returns null when the outbox is missing the file and no bucket is configured', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ rawOutboxDir: outboxDir, storageBucket: '' }))
    const pool = makeFakePool({ blobs: { missing: { s3_key: 'Deutschland/aa/missing.pdf', content_type: 'application/pdf' } } })
    vi.mocked(getPool).mockReturnValue(pool as never)

    expect(await downloadBlob('missing')).toBeNull()
  })
})
