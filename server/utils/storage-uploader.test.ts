import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPool } from './db'
import { getServiceClient } from './supabase'

vi.mock('./db', () => ({ getPool: vi.fn() }))
vi.mock('./supabase', () => ({ getServiceClient: vi.fn() }))

const uploadMock = vi.fn(async (..._args: unknown[]): Promise<{ error: { message: string } | null }> => ({
  error: null,
}))
const fakeSupabase = { storage: { from: vi.fn(() => ({ upload: uploadMock })) } }

const { drainOutbox } = await import('./storage-uploader')

function makeFakePool(rows: Array<{ content_hash: string; s3_key: string; content_type: string }>) {
  const updated: string[] = []
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT content_hash, s3_key, content_type FROM artifact_blobs')) {
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('UPDATE artifact_blobs SET uploaded_at')) {
      updated.push(params[0] as string)
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected query: ${sql}`)
  })
  return { query, updated }
}

describe('drainOutbox', () => {
  let outboxDir: string

  beforeEach(async () => {
    outboxDir = await mkdtemp(join(tmpdir(), 'storage-uploader-test-'))
    uploadMock.mockClear()
    uploadMock.mockResolvedValue({ error: null })
    fakeSupabase.storage.from.mockClear()
    vi.mocked(getServiceClient).mockReturnValue(fakeSupabase as never)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(outboxDir, { recursive: true, force: true })
  })

  it('no-ops without a DB pool', async () => {
    vi.mocked(getPool).mockReturnValue(null)
    vi.stubGlobal('useRuntimeConfig', () => ({ rawOutboxDir: outboxDir, storageBucket: 'raw-archive' }))
    const result = await drainOutbox()
    expect(result).toEqual({ uploaded: 0, failed: 0, missing: 0 })
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('no-ops without a bucket name', async () => {
    vi.mocked(getPool).mockReturnValue({ query: vi.fn() } as never)
    vi.stubGlobal('useRuntimeConfig', () => ({ rawOutboxDir: outboxDir, storageBucket: '' }))
    const result = await drainOutbox()
    expect(result).toEqual({ uploaded: 0, failed: 0, missing: 0 })
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('no-ops when Supabase is not configured', async () => {
    vi.mocked(getPool).mockReturnValue({ query: vi.fn() } as never)
    vi.mocked(getServiceClient).mockReturnValue(null)
    vi.stubGlobal('useRuntimeConfig', () => ({ rawOutboxDir: outboxDir, storageBucket: 'raw-archive' }))
    const result = await drainOutbox()
    expect(result).toEqual({ uploaded: 0, failed: 0, missing: 0 })
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('uploads pending blobs, marks uploaded_at, and deletes the local file', async () => {
    const key = 'ab/abcdef.json.gz'
    const filePath = join(outboxDir, key)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, Buffer.from('gzip-bytes'))

    const pool = makeFakePool([{ content_hash: 'abcdef', s3_key: key, content_type: 'application/json+gzip' }])
    vi.mocked(getPool).mockReturnValue(pool as never)
    vi.stubGlobal('useRuntimeConfig', () => ({ rawOutboxDir: outboxDir, storageBucket: 'raw-archive' }))

    const result = await drainOutbox()

    expect(result).toEqual({ uploaded: 1, failed: 0, missing: 0 })
    expect(fakeSupabase.storage.from).toHaveBeenCalledWith('raw-archive')
    expect(uploadMock).toHaveBeenCalledTimes(1)
    expect(uploadMock).toHaveBeenCalledWith(key, expect.any(Buffer), {
      contentType: 'application/json+gzip',
      upsert: true,
    })
    expect(pool.updated).toEqual(['abcdef'])
    await expect(stat(filePath)).rejects.toThrow()
  })

  it('counts a missing local outbox file without treating it as an upload failure', async () => {
    const key = 'cd/missing.json.gz'
    // Intentionally do not create the outbox file: readFile fails.
    const pool = makeFakePool([{ content_hash: 'missing', s3_key: key, content_type: 'application/json+gzip' }])
    vi.mocked(getPool).mockReturnValue(pool as never)
    vi.stubGlobal('useRuntimeConfig', () => ({ rawOutboxDir: outboxDir, storageBucket: 'raw-archive' }))

    const result = await drainOutbox()

    expect(result).toEqual({ uploaded: 0, failed: 0, missing: 1 })
    expect(uploadMock).not.toHaveBeenCalled()
    expect(pool.updated).toEqual([])
  })

  it('counts an upload that Supabase rejects as failed', async () => {
    const key = 'ef/rejected.json.gz'
    const filePath = join(outboxDir, key)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, Buffer.from('gzip-bytes'))
    uploadMock.mockResolvedValueOnce({ error: { message: 'bucket not found' } })

    const pool = makeFakePool([{ content_hash: 'rejected', s3_key: key, content_type: 'application/json+gzip' }])
    vi.mocked(getPool).mockReturnValue(pool as never)
    vi.stubGlobal('useRuntimeConfig', () => ({ rawOutboxDir: outboxDir, storageBucket: 'raw-archive' }))

    const result = await drainOutbox()

    expect(result).toEqual({ uploaded: 0, failed: 1, missing: 0 })
    expect(pool.updated).toEqual([])
    await expect(stat(filePath)).resolves.toBeTruthy()
  })
})
