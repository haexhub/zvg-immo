import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import {
  claimAuctionTranslation,
  completeAuctionTranslation,
  failAuctionTranslation,
  readContentTranslation,
  writeContentTranslation,
} from './content-translation'

/** Minimal in-memory stand-in for the `pg` Pool, matching the exact queries
 *  content-translation.ts issues (checked via the SQL prefix), mirroring the
 *  fake pool in raw-archive.test.ts. */
function makeFakePool() {
  const rows = new Map<string, {
    title: string | null
    address: string | null
    description: string | null
    documentSummary: string | null
    extractionTexts: unknown
  }>()

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM content_translations')) {
      const [hash, lang] = params as [string, string]
      const hit = rows.get(`${hash}:${lang}`)
      return { rows: hit ? [hit] : [] }
    }
    if (sql.includes('INSERT INTO content_translations')) {
      const [hash, lang, title, address, description, documentSummary, extractionTexts] = params as [
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        unknown,
      ]
      const key = `${hash}:${lang}`
      if (!rows.has(key)) {
        rows.set(key, {
          title,
          address,
          description,
          documentSummary,
          extractionTexts: typeof extractionTexts === 'string' ? JSON.parse(extractionTexts) : extractionTexts,
        })
      }
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected query: ${sql}`)
  })

  return { rows, query: query as unknown as Pool['query'] }
}

describe('readContentTranslation / writeContentTranslation', () => {
  it('returns null on a cache miss', async () => {
    const pool = makeFakePool()
    const hit = await readContentTranslation({ query: pool.query } as Pool, 'hash-a', 'en')
    expect(hit).toBeNull()
  })

  it('returns the written row on a cache hit', async () => {
    const pool = makeFakePool()
    const db = { query: pool.query } as Pool
    await writeContentTranslation(db, 'hash-a', 'en', 'Title EN', 'Address EN', 'Description EN', 'Document summary EN', {
      biddingNotes: null,
      renovationNotes: 'Renovation notes EN',
      floor: null,
      heating: null,
      insights: null,
      planningNotes: null,
    })
    const hit = await readContentTranslation(db, 'hash-a', 'en')
    expect(hit).toEqual({
      title: 'Title EN',
      address: 'Address EN',
      description: 'Description EN',
      documentSummary: 'Document summary EN',
      extractionTexts: {
        biddingNotes: null,
        renovationNotes: 'Renovation notes EN',
        floor: null,
        heating: null,
        insights: null,
        planningNotes: null,
      },
    })
  })

  it('is keyed on (content_hash, lang) — a different lang is a separate entry', async () => {
    const pool = makeFakePool()
    const db = { query: pool.query } as Pool
    await writeContentTranslation(db, 'hash-a', 'en', 'Title EN', null, 'Description EN', null, null)
    const hitDe = await readContentTranslation(db, 'hash-a', 'de')
    expect(hitDe).toBeNull()
  })

  it('is immutable per (content_hash, lang) — a second write does not overwrite', async () => {
    const pool = makeFakePool()
    const db = { query: pool.query } as Pool
    await writeContentTranslation(db, 'hash-a', 'en', 'First', null, 'First desc', 'First document', null)
    await writeContentTranslation(db, 'hash-a', 'en', 'Second', null, 'Second desc', 'Second document', {
      biddingNotes: 'Second note',
      renovationNotes: null,
      floor: null,
      heating: null,
      insights: null,
      planningNotes: null,
    })
    const hit = await readContentTranslation(db, 'hash-a', 'en')
    expect(hit).toEqual({
      title: 'First',
      address: null,
      description: 'First desc',
      documentSummary: 'First document',
      extractionTexts: null,
    })
  })

  it('a changed content_hash is a distinct cache entry (content change -> new translation)', async () => {
    const pool = makeFakePool()
    const db = { query: pool.query } as Pool
    await writeContentTranslation(db, 'hash-a', 'en', 'Old title', null, 'Old desc', 'Old document', null)
    const hitNewHash = await readContentTranslation(db, 'hash-b', 'en')
    expect(hitNewHash).toBeNull()
  })
})

/** Simulates the one real-Postgres behaviour the bug hinges on: a
 *  `timestamptz` column keeps microsecond precision, but node-postgres
 *  parses it into a JS `Date` (millisecond precision) on RETURNING. A row
 *  written via a plain `now()` therefore carries a nonzero microsecond
 *  remainder that a later `WHERE started_at = $n` (fed that same `Date` back
 *  as a parameter) can never match — unless the writer truncated to
 *  milliseconds up front, exactly like `date_trunc('milliseconds', now())`. */
function makeFakeAuctionTranslationPool() {
  const rows = new Map<string, {
    status: 'pending' | 'completed' | 'failed'
    startedAtMs: number
    startedAtHasMicroRemainder: boolean
    title: string | null
    errorMessage: string | null
  }>()

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO auction_translations')) {
      const [platform, externalId, version, lang] = params as [string, string, number, string, string]
      const key = `${platform}:${externalId}:${version}:${lang}`
      const truncated = sql.includes("date_trunc('milliseconds', now())")
      const startedAtMs = Date.now()
      rows.set(key, {
        status: 'pending',
        startedAtMs,
        startedAtHasMicroRemainder: !truncated,
        title: null,
        errorMessage: null,
      })
      return { rows: [{ startedAt: new Date(startedAtMs) }] }
    }
    if (sql.includes("status = 'completed'")) {
      const [platform, externalId, version, lang, startedAt, title] = params as [string, string, number, string, Date, string]
      const key = `${platform}:${externalId}:${version}:${lang}`
      const row = rows.get(key)
      const matches =
        row?.status === 'pending' && !row.startedAtHasMicroRemainder && row.startedAtMs === startedAt.getTime()
      if (matches) {
        row.status = 'completed'
        row.title = title
      }
      return { rowCount: matches ? 1 : 0 }
    }
    if (sql.includes("status = 'failed'")) {
      const [platform, externalId, version, lang, startedAt, errorMessage] = params as [string, string, number, string, Date, string]
      const key = `${platform}:${externalId}:${version}:${lang}`
      const row = rows.get(key)
      const matches =
        row?.status === 'pending' && !row.startedAtHasMicroRemainder && row.startedAtMs === startedAt.getTime()
      if (matches) {
        row.status = 'failed'
        row.errorMessage = errorMessage
      }
      return { rowCount: matches ? 1 : 0 }
    }
    throw new Error(`unexpected query: ${sql}`)
  })

  return { rows, query: query as unknown as Pool['query'] }
}

describe('claimAuctionTranslation / completeAuctionTranslation / failAuctionTranslation', () => {
  it('a claim can be completed — started_at survives the Postgres round trip', async () => {
    const pool = makeFakeAuctionTranslationPool()
    const db = { query: pool.query } as Pool
    const claim = await claimAuctionTranslation(db, 'se-kronofogden', '101735', 1, 'de', 'hash-a')
    expect(claim).not.toBeNull()
    await completeAuctionTranslation(db, 'se-kronofogden', '101735', 1, 'de', claim!, {
      title: 'Translated title',
      address: null,
      description: null,
      documentSummary: null,
      extractionTexts: null,
    })
    expect(pool.rows.get('se-kronofogden:101735:1:de')?.status).toBe('completed')
  })

  it('a claim can be failed — started_at survives the Postgres round trip', async () => {
    const pool = makeFakeAuctionTranslationPool()
    const db = { query: pool.query } as Pool
    const claim = await claimAuctionTranslation(db, 'bg-zapori', '3500', 2, 'de', 'hash-b')
    expect(claim).not.toBeNull()
    await failAuctionTranslation(db, 'bg-zapori', '3500', 2, 'de', claim!, 'LLM ist nicht konfiguriert', null)
    const row = pool.rows.get('bg-zapori:3500:2:de')
    expect(row?.status).toBe('failed')
    expect(row?.errorMessage).toBe('LLM ist nicht konfiguriert')
  })
})
