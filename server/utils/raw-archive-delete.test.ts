import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/node-postgres'
import { getDb } from './db'
import { getServiceClient } from './supabase'

vi.mock('./db', () => ({ getDb: vi.fn() }))
vi.mock('./supabase', () => ({ getServiceClient: vi.fn() }))

const removeMock = vi.fn(async (_keys: string[]) => ({ error: null }))
const fakeSupabase = { storage: { from: vi.fn(() => ({ remove: removeMock })) } }

const { deleteRawArchiveCountry } = await import('./raw-archive-delete')

function queryText(queryArg: unknown): string {
  return typeof queryArg === 'string' ? queryArg : (queryArg as { text: string }).text
}

/** Builds a `getDb()`-shaped fake: a real Drizzle instance wrapping a mock
 *  `pg.Pool`, so `db.transaction()` behaves like production (checks out one
 *  connection, BEGIN/COMMIT/ROLLBACK, releases it) while the actual queries
 *  hit this in-memory matcher. Matched on the compiled SQL Drizzle sends to
 *  `client.query()`, not the hand-written strings the old raw-SQL version used. */
function makeClient() {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const query = vi.fn(async (queryArg: unknown, params: unknown[] = []) => {
    const text = queryText(queryArg)
    queries.push({ sql: text, params })
    const n = text.replace(/\s+/g, ' ').trim().toLowerCase()
    if (n === 'begin' || n === 'commit' || n === 'rollback') {
      return { rows: [], rowCount: null }
    }
    if (n.startsWith('select distinct "content_hash", "s3_key" from "artifact_blobs"')) {
      // array-mode rows: [contentHash, s3Key] per the select's field order.
      return {
        rows: [
          ['orphan', 'Deutschland/aa/orphan.pdf'],
          ['shared', 'Deutschland/bb/shared.pdf'],
        ],
        rowCount: 2,
      }
    }
    if (n.startsWith('select count(*) from "artifact_versions"')) {
      return { rows: [['3']], rowCount: 1 }
    }
    if (n.startsWith('delete from "artifact_versions"')) {
      return { rows: [], rowCount: 2 }
    }
    if (n.startsWith('delete from "artifact_captures"')) {
      return { rows: [], rowCount: 5 }
    }
    if (n.startsWith('delete from "artifact_blobs"')) {
      return { rows: [['orphan', 'Deutschland/aa/orphan.pdf']], rowCount: 1 }
    }
    throw new Error(`unexpected query: ${text}`)
  })
  function MockPool() {}
  const pool = Object.assign(new (MockPool as unknown as new () => object)(), {
    query: vi.fn(async () => { throw new Error('unexpected direct pool query') }),
    connect: vi.fn(async () => client),
  })
  const client = { query, release: vi.fn() }
  return { query, release: client.release, queries, db: drizzle(pool as never) }
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
    vi.mocked(getDb).mockReturnValue(client.db as never)

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
    expect(client.queries.map((q) => q.sql)).toContain('begin')
    expect(client.queries.map((q) => q.sql)).toContain('commit')
    expect(client.release).toHaveBeenCalledOnce()
    await expect(readFile(localPath)).rejects.toThrow()
    expect(fakeSupabase.storage.from).toHaveBeenCalledWith('raw-archive')
    expect(removeMock).toHaveBeenCalledWith(['Deutschland/aa/orphan.pdf'])
  })

  it('rejects invalid country codes before touching the DB', async () => {
    await expect(deleteRawArchiveCountry('de;drop')).rejects.toMatchObject({ statusCode: 400 })
    expect(getDb).not.toHaveBeenCalled()
  })

  it('returns 503 when the archive DB is not configured', async () => {
    vi.mocked(getDb).mockReturnValue(null)

    await expect(deleteRawArchiveCountry('de')).rejects.toMatchObject({ statusCode: 503 })
  })

  it('rolls back and releases the client when a transaction query fails', async () => {
    const client = makeClient()
    client.query.mockImplementation(async (queryArg: unknown, params: unknown[] = []) => {
      const text = queryText(queryArg)
      client.queries.push({ sql: text, params })
      const n = text.replace(/\s+/g, ' ').trim().toLowerCase()
      if (n === 'begin' || n === 'rollback') return { rows: [], rowCount: null }
      if (n.startsWith('select distinct "content_hash", "s3_key" from "artifact_blobs"')) return { rows: [], rowCount: 0 }
      if (n.startsWith('select count(*) from "artifact_versions"')) throw new Error('count failed')
      throw new Error(`unexpected query: ${text}`)
    })
    vi.mocked(getDb).mockReturnValue(client.db as never)

    await expect(deleteRawArchiveCountry('de')).rejects.toMatchObject({ statusCode: 500 })
    expect(client.queries.map((q) => q.sql.toLowerCase())).toContain('rollback')
    expect(client.release).toHaveBeenCalledOnce()
    expect(removeMock).not.toHaveBeenCalled()
  })
})
