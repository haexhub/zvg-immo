import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/node-postgres'
import { getDb } from './db'
import { getServiceClient } from './supabase'
import { queryText } from '~/test-support/drizzle-query'

vi.mock('./db', () => ({ getDb: vi.fn() }))
vi.mock('./supabase', () => ({ getServiceClient: vi.fn() }))

const removeMock = vi.fn(async (_keys: string[]) => ({ error: null }))
const fakeSupabase = { storage: { from: vi.fn(() => ({ remove: removeMock })) } }

const { deleteRawArchiveCountry } = await import('./raw-archive-delete')

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
    if (n.startsWith('update auction_details set is_latest = true')) {
      return { rows: [], rowCount: 1 }
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
    // The is_latest repair belongs inside the same transaction as the cascade
    // that caused the gap, scoped to this country.
    const promotion = client.queries.findIndex((q) => q.sql.trim().toLowerCase().startsWith('update auction_details'))
    expect(promotion).toBeGreaterThan(-1)
    expect(client.queries[promotion]?.params).toEqual(['de'])
    expect(promotion).toBeLessThan(client.queries.findIndex((q) => q.sql === 'commit'))
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

// The gap this repairs is produced by fk_auction_details_artifact_version's
// ON DELETE CASCADE, so proving it needs a real database rather than the SQL
// matcher above. Skipped unless one is configured.
const TEST_DB = process.env.TEST_DATABASE_URL
const describeDb = TEST_DB ? describe : describe.skip

describeDb('deleteRawArchiveCountry is_latest repair (real Postgres)', () => {
  let pool: import('pg').Pool

  beforeAll(async () => {
    const { Pool } = await import('pg')
    pool = new Pool({ connectionString: TEST_DB })
  })

  afterAll(async () => {
    await pool.end()
  })

  // Own identity and country: test files share the database, so nothing here
  // may delete or insert rows another file is using.
  const PLATFORM = 'archive-delete-test'
  const EXTERNAL_ID = 'ad-1'
  const COUNTRY = 'xx'

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(getServiceClient).mockReturnValue(null as never)
    vi.stubGlobal('useRuntimeConfig', () => ({ rawOutboxDir: tmpdir(), storageBucket: null }))
    vi.mocked(getDb).mockReturnValue(drizzle(pool) as never)
    // auction_details/artifact_versions cascade off the auctions row.
    await pool.query('DELETE FROM auctions WHERE platform = $1', [PLATFORM])
    await pool.query(
      `INSERT INTO auctions (platform, external_id, country, region, authority, case_number, cancelled)
       VALUES ($1, $2, $3, 'Brandenburg', 'Neuruppin', '7 K 168/25', false)`,
      [PLATFORM, EXTERNAL_ID, COUNTRY],
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** v1 = listing-only (artifact_version_id NULL, out of the cascade's reach),
   *  v2 = live and bound to the manifest the delete removes. */
  async function seedVersions(v1: { isTrial: boolean }): Promise<void> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO artifact_versions (captured_at, last_seen_at, platform, external_id, set_hash, version, document_count)
       VALUES (now(), now(), $1, $2, 'set-hash-1', 1, 0) RETURNING id`,
      [PLATFORM, EXTERNAL_ID],
    )
    await pool.query(
      `INSERT INTO auction_details (platform, external_id, version, extracted_at, is_latest, is_trial, artifact_version_id)
       VALUES ($1, $2, 1, now(), false, $3, NULL),
              ($1, $2, 2, now(), true, false, $4)`,
      [PLATFORM, EXTERNAL_ID, v1.isTrial, rows[0]?.id],
    )
  }

  async function readVersions(): Promise<Array<{ version: number; is_latest: boolean }>> {
    const { rows } = await pool.query<{ version: number; is_latest: boolean }>(
      'SELECT version, is_latest FROM auction_details WHERE platform = $1 ORDER BY version',
      [PLATFORM],
    )
    return rows
  }

  it('promotes the newest surviving version when the cascade took the live row', async () => {
    await seedVersions({ isTrial: false })

    await deleteRawArchiveCountry(COUNTRY)

    expect(await readVersions()).toEqual([{ version: 1, is_latest: true }])
  })

  it('never promotes a trial version — going live stays an explicit action', async () => {
    await seedVersions({ isTrial: true })

    await deleteRawArchiveCountry(COUNTRY)

    expect(await readVersions()).toEqual([{ version: 1, is_latest: false }])
  })
})
