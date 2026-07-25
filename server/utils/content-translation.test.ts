import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { readContentTranslation, writeContentTranslation } from './content-translation'

/** Minimal in-memory stand-in for the `pg` Pool, matching the exact queries
 *  content-translation.ts issues (checked via the SQL prefix), mirroring the
 *  fake pool in raw-archive.test.ts. */
function makeFakePool() {
  const rows = new Map<string, {
    title: string | null
    description: string | null
    documentSummary: string | null
  }>()

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM content_translations')) {
      const [hash, lang] = params as [string, string]
      const hit = rows.get(`${hash}:${lang}`)
      return { rows: hit ? [hit] : [] }
    }
    if (sql.includes('INSERT INTO content_translations')) {
      const [hash, lang, title, description, documentSummary] = params as [
        string,
        string,
        string | null,
        string | null,
        string | null,
      ]
      const key = `${hash}:${lang}`
      if (!rows.has(key)) rows.set(key, { title, description, documentSummary })
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
    await writeContentTranslation(db, 'hash-a', 'en', 'Title EN', 'Description EN', 'Document summary EN')
    const hit = await readContentTranslation(db, 'hash-a', 'en')
    expect(hit).toEqual({
      title: 'Title EN',
      description: 'Description EN',
      documentSummary: 'Document summary EN',
    })
  })

  it('is keyed on (content_hash, lang) — a different lang is a separate entry', async () => {
    const pool = makeFakePool()
    const db = { query: pool.query } as Pool
    await writeContentTranslation(db, 'hash-a', 'en', 'Title EN', 'Description EN', null)
    const hitDe = await readContentTranslation(db, 'hash-a', 'de')
    expect(hitDe).toBeNull()
  })

  it('is immutable per (content_hash, lang) — a second write does not overwrite', async () => {
    const pool = makeFakePool()
    const db = { query: pool.query } as Pool
    await writeContentTranslation(db, 'hash-a', 'en', 'First', 'First desc', 'First document')
    await writeContentTranslation(db, 'hash-a', 'en', 'Second', 'Second desc', 'Second document')
    const hit = await readContentTranslation(db, 'hash-a', 'en')
    expect(hit).toEqual({
      title: 'First',
      description: 'First desc',
      documentSummary: 'First document',
    })
  })

  it('a changed content_hash is a distinct cache entry (content change -> new translation)', async () => {
    const pool = makeFakePool()
    const db = { query: pool.query } as Pool
    await writeContentTranslation(db, 'hash-a', 'en', 'Old title', 'Old desc', 'Old document')
    const hitNewHash = await readContentTranslation(db, 'hash-b', 'en')
    expect(hitNewHash).toBeNull()
  })
})
