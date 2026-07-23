import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { DEFAULT_LLM_MAX_TOKENS, getAllLlmMaxTokens, getLlmMaxTokens, setLlmMaxTokens } from './app-settings'

/** Minimal in-memory stand-in for the `pg` Pool, matching the exact queries
 *  app-settings.ts issues (checked via the SQL prefix), mirroring the fake
 *  pool in content-translation.test.ts. */
function makeFakePool() {
  const rows = new Map<string, unknown>()

  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT value FROM app_settings WHERE key =')) {
      const [key] = params as [string]
      return rows.has(key) ? { rows: [{ value: rows.get(key) }] } : { rows: [] }
    }
    if (sql.includes('SELECT key, value FROM app_settings WHERE key = ANY')) {
      const [keys] = params as [string[]]
      return { rows: keys.filter((k) => rows.has(k)).map((k) => ({ key: k, value: rows.get(k) })) }
    }
    if (sql.includes('INSERT INTO app_settings')) {
      const [key, value] = params as [string, string]
      rows.set(key, JSON.parse(value))
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected query: ${sql}`)
  }

  return { query: query as unknown as Pool['query'] }
}

describe('getLlmMaxTokens', () => {
  it('falls back to the default when no row exists', async () => {
    const db = makeFakePool() as unknown as Pool
    expect(await getLlmMaxTokens(db, 'extraction')).toBe(DEFAULT_LLM_MAX_TOKENS.extraction)
    expect(await getLlmMaxTokens(db, 'summary')).toBe(DEFAULT_LLM_MAX_TOKENS.summary)
    expect(await getLlmMaxTokens(db, 'translation')).toBe(DEFAULT_LLM_MAX_TOKENS.translation)
  })

  it('returns a previously written value', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmMaxTokens(db, 'summary', 2048)
    expect(await getLlmMaxTokens(db, 'summary')).toBe(2048)
  })

  it('falls back to the default on a malformed value', async () => {
    const db = makeFakePool()
    ;(db as unknown as { query: (sql: string, params?: unknown[]) => Promise<unknown> }).query = async (
      sql: string,
    ) => {
      if (sql.includes('SELECT value')) return { rows: [{ value: 'not-a-number' }] }
      throw new Error('unexpected')
    }
    expect(await getLlmMaxTokens(db as unknown as Pool, 'extraction')).toBe(DEFAULT_LLM_MAX_TOKENS.extraction)
  })
})

describe('getAllLlmMaxTokens', () => {
  it('mixes defaults and overrides for a partially configured set', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmMaxTokens(db, 'translation', 16_000)
    expect(await getAllLlmMaxTokens(db)).toEqual({
      extraction: DEFAULT_LLM_MAX_TOKENS.extraction,
      summary: DEFAULT_LLM_MAX_TOKENS.summary,
      translation: 16_000,
    })
  })
})

describe('setLlmMaxTokens', () => {
  it('clamps a too-low value up to the minimum', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmMaxTokens(db, 'summary', 10)
    expect(await getLlmMaxTokens(db, 'summary')).toBe(256)
  })

  it('clamps a too-high value down to the maximum', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmMaxTokens(db, 'extraction', 1_000_000)
    expect(await getLlmMaxTokens(db, 'extraction')).toBe(32_768)
  })

  it('rounds a non-integer value', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmMaxTokens(db, 'summary', 1024.6)
    expect(await getLlmMaxTokens(db, 'summary')).toBe(1025)
  })

  it('overwrites a previously set value', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmMaxTokens(db, 'summary', 2048)
    await setLlmMaxTokens(db, 'summary', 3000)
    expect(await getLlmMaxTokens(db, 'summary')).toBe(3000)
  })
})
