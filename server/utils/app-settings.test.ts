import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import {
  DEFAULT_ENABLED_COUNTRIES,
  DEFAULT_HIDE_RULES_ONLY_AUCTIONS,
  DEFAULT_LLM_MAX_TOKENS,
  clearLlmProviderOverride,
  getAllLlmMaxTokens,
  getEnabledCountries,
  getHideRulesOnlyAuctions,
  getLlmMaxTokens,
  getLlmProviderOverride,
  setEnabledCountries,
  setHideRulesOnlyAuctions,
  setLlmMaxTokens,
  setLlmProviderOverride,
} from './app-settings'

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
      if (params.length === 2) {
        const [key, value] = params as [string, string]
        rows.set(key, JSON.parse(value))
        return { rows: [], rowCount: 1 }
      }
      // setLlmProviderOverride's atomic upsert: [key, provider, baseUrl, model, apiKey|null].
      // Emulates the SQL's COALESCE($5, current.apiKey, '') without a real jsonb engine.
      const [key, provider, baseUrl, model, apiKey] = params as [string, string, string, string, string | null]
      const existing = rows.get(key) as { apiKey?: string } | undefined
      const value = { provider, baseUrl, model, apiKey: apiKey ?? existing?.apiKey ?? '' }
      rows.set(key, value)
      return { rows: [{ value }], rowCount: 1 }
    }
    if (sql.includes('DELETE FROM app_settings')) {
      const [key] = params as [string]
      const existed = rows.delete(key)
      return { rows: [], rowCount: existed ? 1 : 0 }
    }
    throw new Error(`unexpected query: ${sql}`)
  }

  return { query: query as unknown as Pool['query'] }
}

describe('enabled countries', () => {
  it('defaults to Germany and Sweden when no row exists', async () => {
    const db = makeFakePool() as unknown as Pool
    expect(await getEnabledCountries(db)).toEqual(DEFAULT_ENABLED_COUNTRIES)
  })

  it('persists a normalized, duplicate-free country list', async () => {
    const db = makeFakePool() as unknown as Pool
    await setEnabledCountries(db, ['SE', 'de', 'se'])
    expect(await getEnabledCountries(db)).toEqual(['se', 'de'])
  })

  it('allows all country sources to be paused', async () => {
    const db = makeFakePool() as unknown as Pool
    await setEnabledCountries(db, [])
    expect(await getEnabledCountries(db)).toEqual([])
  })

  it('falls back to defaults for a malformed stored value', async () => {
    const db = makeFakePool()
    ;(db as unknown as { query: (sql: string) => Promise<unknown> }).query = async (sql: string) => {
      if (sql.includes('SELECT value')) return { rows: [{ value: 'de,se' }] }
      throw new Error('unexpected')
    }
    expect(await getEnabledCountries(db as unknown as Pool)).toEqual(DEFAULT_ENABLED_COUNTRIES)
  })
})

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

  it('clamps a stored out-of-range value that bypassed setLlmMaxTokens', async () => {
    const db = makeFakePool()
    ;(db as unknown as { query: (sql: string, params?: unknown[]) => Promise<unknown> }).query = async (
      sql: string,
    ) => {
      if (sql.includes('SELECT value')) return { rows: [{ value: 1_000_000 }] }
      throw new Error('unexpected')
    }
    expect(await getLlmMaxTokens(db as unknown as Pool, 'extraction')).toBe(32_768)
  })

  it('rounds a stored fractional value that bypassed setLlmMaxTokens', async () => {
    const db = makeFakePool()
    ;(db as unknown as { query: (sql: string, params?: unknown[]) => Promise<unknown> }).query = async (
      sql: string,
    ) => {
      if (sql.includes('SELECT value')) return { rows: [{ value: 1024.6 }] }
      throw new Error('unexpected')
    }
    expect(await getLlmMaxTokens(db as unknown as Pool, 'summary')).toBe(1025)
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

describe('getLlmProviderOverride', () => {
  it('returns null when no row exists', async () => {
    const db = makeFakePool() as unknown as Pool
    expect(await getLlmProviderOverride(db)).toBeNull()
  })

  it('returns a previously written override', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmProviderOverride(db, {
      provider: 'claude-proxy',
      baseUrl: 'http://haex-claude-proxy:8080',
      model: 'claude-haiku-4-5',
      apiKey: '',
    })
    expect(await getLlmProviderOverride(db)).toEqual({
      provider: 'claude-proxy',
      baseUrl: 'http://haex-claude-proxy:8080',
      model: 'claude-haiku-4-5',
      apiKey: '',
    })
  })

  it('returns null for a malformed stored value', async () => {
    const db = makeFakePool()
    ;(db as unknown as { query: (sql: string, params?: unknown[]) => Promise<unknown> }).query = async (
      sql: string,
    ) => {
      if (sql.includes('SELECT value')) return { rows: [{ value: { provider: 'not-a-real-provider' } }] }
      throw new Error('unexpected')
    }
    expect(await getLlmProviderOverride(db as unknown as Pool)).toBeNull()
  })

  it('is null again after clearLlmProviderOverride', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmProviderOverride(db, {
      provider: 'gemini-native',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-flash-latest',
      apiKey: 'secret',
    })
    await clearLlmProviderOverride(db)
    expect(await getLlmProviderOverride(db)).toBeNull()
  })
})

describe('getHideRulesOnlyAuctions', () => {
  it('defaults to true when no row exists', async () => {
    const db = makeFakePool() as unknown as Pool
    expect(await getHideRulesOnlyAuctions(db)).toBe(DEFAULT_HIDE_RULES_ONLY_AUCTIONS)
  })

  it('returns a previously written value', async () => {
    const db = makeFakePool() as unknown as Pool
    await setHideRulesOnlyAuctions(db, false)
    expect(await getHideRulesOnlyAuctions(db)).toBe(false)
  })
})
