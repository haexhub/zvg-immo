import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPool } from './db'
import { getServiceClient } from './supabase'

vi.mock('./db', () => ({ getPool: vi.fn() }))
vi.mock('./supabase', () => ({ getServiceClient: vi.fn() }))

const removeMock = vi.fn(async (_keys: string[]) => ({ error: null }))
const fakeSupabase = { storage: { from: vi.fn(() => ({ remove: removeMock })) } }

const { deleteRawArchiveCountry } = await import('./raw-archive-delete')

function makeClient() {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params })
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [], rowCount: null }
    }
    if (sql.includes('SELECT DISTINCT rb.content_hash')) {
      return {
        rows: [
          { content_hash: 'orphan', s3_key: 'Deutschland/aa/orphan.pdf' },
          { content_hash: 'shared', s3_key: 'Deutschland/bb/shared.pdf' },
        ],
        rowCount: 2,
      }
    }
    if (sql.includes('SELECT count(*) AS count')) {
      return { rows: [{ count: '3' }], rowCount: 1 }
    }
    if (sql.includes('DELETE FROM raw_document_sets')) {
      return { rows: [], rowCount: 2 }
    }
    if (sql.includes('DELETE FROM raw_captures')) {
      return { rows: [], rowCount: 5 }
    }
    if (sql.includes('DELETE FROM raw_blobs')) {
      return { rows: [{ content_hash: 'orphan', s3_key: 'Deutschland/aa/orphan.pdf' }], rowCount: 1 }
    }
    throw new Error(`unexpected query: ${sql}`)
  })
  return { query, release: vi.fn(), queries }
}

describe('deleteRawArchiveCountry', () => {
  let outboxDir: string

  beforeEach(async () => {
    outboxDir = await mkdtemp(join(tmpdir(), 'raw-archive-delete-test-'))
    vi.clearAllMocks()
    removeMock.mockClear()
    fakeSupabase.storage.from.mockClear()
    vi.mocked(getServiceClient).mockReturnValue(fakeSupabase as never)
    vi.stubGlobal('useRuntimeConfig', () => ({
      rawOutboxDir: outboxDir,
      storageBucket: 'raw-archive',
    }))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(outboxDir, { recursive: true, force: true })
  })

  it('deletes a country archive and removes only blobs that became orphaned', async () => {
    const localPath = join(outboxDir, 'Deutschland/aa/orphan.pdf')
    await mkdir(dirname(localPath), { recursive: true })
    await writeFile(localPath, Buffer.from('%PDF-1.4 orphan'))

    const client = makeClient()
    vi.mocked(getPool).mockReturnValue({ connect: vi.fn(async () => client) } as never)

    const result = await deleteRawArchiveCountry('DE')

    expect(result).toEqual({
      country: 'de',
      deleted: {
        captures: 5,
        documentSets: 2,
        documentSetItems: 3,
        blobs: 1,
        localFiles: 1,
        storageFiles: 1,
      },
      failed: {
        localFiles: 0,
        storageFiles: 0,
      },
    })
    expect(client.queries.map((q) => q.sql)).toContain('BEGIN')
    expect(client.queries.map((q) => q.sql)).toContain('COMMIT')
    expect(client.release).toHaveBeenCalledOnce()
    await expect(readFile(localPath)).rejects.toThrow()
    expect(fakeSupabase.storage.from).toHaveBeenCalledWith('raw-archive')
    expect(removeMock).toHaveBeenCalledWith(['Deutschland/aa/orphan.pdf'])
  })

  it('rejects invalid country codes before touching the DB', async () => {
    await expect(deleteRawArchiveCountry('de;drop')).rejects.toMatchObject({ statusCode: 400 })
    expect(getPool).not.toHaveBeenCalled()
  })

  it('returns 503 when the archive DB is not configured', async () => {
    vi.mocked(getPool).mockReturnValue(null)

    await expect(deleteRawArchiveCountry('de')).rejects.toMatchObject({ statusCode: 503 })
  })

  it('rolls back and releases the client when a transaction query fails', async () => {
    const client = makeClient()
    client.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      client.queries.push({ sql, params })
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [], rowCount: null }
      if (sql.includes('SELECT DISTINCT rb.content_hash')) return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT count(*) AS count')) throw new Error('count failed')
      throw new Error(`unexpected query: ${sql}`)
    })
    vi.mocked(getPool).mockReturnValue({ connect: vi.fn(async () => client) } as never)

    await expect(deleteRawArchiveCountry('de')).rejects.toMatchObject({ statusCode: 500 })
    expect(client.queries.map((q) => q.sql)).toContain('ROLLBACK')
    expect(client.release).toHaveBeenCalledOnce()
    expect(removeMock).not.toHaveBeenCalled()
  })
})
