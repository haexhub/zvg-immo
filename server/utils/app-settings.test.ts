import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import {
  DEFAULT_ENABLED_COUNTRIES,
  DEFAULT_HIDE_RULES_ONLY_AUCTIONS,
  DEFAULT_LLM_EXECUTION_MODE,
  DEFAULT_LLM_MAX_TOKENS,
  clearLlmProviderOverride,
  getAllLlmMaxTokens,
  getEnabledCountries,
  getHideRulesOnlyAuctions,
  getLlmMaxTokens,
  getLlmProviderProfileSettings,
  getLlmProviderOverride,
  setEnabledCountries,
  setHideRulesOnlyAuctions,
  setLlmMaxTokens,
  setLlmProviderProfileSettings,
  setLlmProviderOverride,
} from './app-settings'

/** Minimal in-memory stand-in for the `pg` Pool, matching the exact queries
 *  app-settings.ts issues (checked via the SQL prefix), mirroring the fake
 *  pool in content-translation.test.ts. */
function makeFakePool() {
  const rows = new Map<string, unknown>()

  const query = async (sql: string, params: unknown[] = []) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [], rowCount: null }
    }
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
      // setLlmProviderOverride's atomic upsert:
      // [key, provider, baseUrl, model, executionMode|null, apiKey|null, defaultExecutionMode].
      // Emulates the SQL's COALESCEs without a real jsonb engine.
      const [key, provider, baseUrl, model, executionMode, apiKey, defaultExecutionMode] = params as [
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string,
      ]
      const existing = rows.get(key) as { apiKey?: string; executionMode?: string } | undefined
      const value = {
        provider,
        baseUrl,
        model,
        executionMode: executionMode ?? existing?.executionMode ?? defaultExecutionMode,
        apiKey: apiKey ?? existing?.apiKey ?? '',
      }
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

  return {
    query: query as unknown as Pool['query'],
    connect: async () => ({
      query: query as unknown as Pool['query'],
      release: () => undefined,
    }),
  }
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

  it('returns a previously written sync override', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmProviderOverride(db, {
      provider: 'claude-proxy',
      baseUrl: 'http://haex-claude-proxy:8080',
      model: 'claude-haiku-4-5',
      executionMode: 'sync',
      apiKey: '',
    })
    expect(await getLlmProviderOverride(db)).toEqual({
      provider: 'claude-proxy',
      baseUrl: 'http://haex-claude-proxy:8080',
      model: 'claude-haiku-4-5',
      executionMode: 'sync',
      apiKey: '',
    })
  })

  it('keeps extraction and translation provider overrides separate', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmProviderOverride(db, {
      provider: 'claude-proxy',
      baseUrl: 'http://haex-claude-proxy:8080',
      model: 'claude-sonnet-5',
      executionMode: 'sync',
      apiKey: '',
    })
    await setLlmProviderOverride(db, {
      provider: 'gemini-native',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-flash-latest',
      executionMode: 'sync',
      apiKey: 'gemini-secret',
    }, 'translation')

    expect(await getLlmProviderOverride(db, 'extraction')).toEqual({
      provider: 'claude-proxy',
      baseUrl: 'http://haex-claude-proxy:8080',
      model: 'claude-sonnet-5',
      executionMode: 'sync',
      apiKey: '',
    })
    expect(await getLlmProviderOverride(db, 'translation')).toEqual({
      provider: 'gemini-native',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-flash-latest',
      executionMode: 'sync',
      apiKey: 'gemini-secret',
    })
  })

  it('persists an explicit batch execution mode', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmProviderOverride(db, {
      provider: 'gemini-native',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-flash-latest',
      executionMode: 'batch',
      apiKey: 'secret',
    })
    expect(await getLlmProviderOverride(db)).toEqual({
      provider: 'gemini-native',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-flash-latest',
      executionMode: 'batch',
      apiKey: 'secret',
    })
  })

  it('preserves the stored executionMode when an update omits it', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmProviderOverride(db, {
      provider: 'gemini-native',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-flash-latest',
      executionMode: 'batch',
      apiKey: 'secret',
    })
    await setLlmProviderOverride(db, {
      provider: 'gemini-native',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-flash-next',
    })
    expect(await getLlmProviderOverride(db)).toEqual({
      provider: 'gemini-native',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-flash-next',
      executionMode: 'batch',
      apiKey: 'secret',
    })
  })

  it('defaults a new override to sync when executionMode is omitted', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmProviderOverride(db, {
      provider: 'claude-proxy',
      baseUrl: 'http://haex-claude-proxy:8080',
      model: 'claude-haiku-4-5',
    })
    expect((await getLlmProviderOverride(db))?.executionMode).toBe(DEFAULT_LLM_EXECUTION_MODE)
  })

  it('rejects stored batch overrides for providers without batch support', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmProviderOverride(db, {
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.test/v1',
      model: 'gpt-test',
      executionMode: 'sync',
    })
    await expect(setLlmProviderOverride(db, {
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.test/v1',
      model: 'gpt-test',
      executionMode: 'batch',
    })).rejects.toThrow('unsupported provider/executionMode combination')
  })

  it('allows OpenAI-compatible batch mode only for the real OpenAI API with a saved key', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmProviderOverride(db, {
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-test',
      executionMode: 'batch',
      apiKey: 'sk-test',
    })
    expect(await getLlmProviderOverride(db)).toEqual({
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-test',
      executionMode: 'batch',
      apiKey: 'sk-test',
    })

    await expect(setLlmProviderOverride(db, {
      provider: 'openai-compatible',
      baseUrl: 'https://api.moonshot.ai/v1',
      model: 'kimi',
      executionMode: 'batch',
      apiKey: 'sk-test',
    })).rejects.toThrow('unsupported provider/executionMode combination')

    const dbWithoutKey = makeFakePool() as unknown as Pool
    await expect(setLlmProviderOverride(dbWithoutKey, {
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-test',
      executionMode: 'batch',
      apiKey: '',
    })).rejects.toThrow('unsupported provider/executionMode combination')
  })

  it('rejects claude-proxy batch overrides without an apiKey', async () => {
    const db = makeFakePool() as unknown as Pool
    await expect(setLlmProviderOverride(db, {
      provider: 'claude-proxy',
      baseUrl: 'http://haex-claude-proxy:8080',
      model: 'claude-haiku-4-5',
      executionMode: 'batch',
      apiKey: '',
    })).rejects.toThrow('unsupported provider/executionMode combination')
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

  it('returns null when a stored provider override is missing executionMode', async () => {
    const db = makeFakePool()
    ;(db as unknown as { query: (sql: string, params?: unknown[]) => Promise<unknown> }).query = async (
      sql: string,
    ) => {
      if (sql.includes('SELECT value')) {
        return {
          rows: [{
            value: {
              provider: 'claude-proxy',
              baseUrl: 'http://haex-claude-proxy:8080',
              model: 'claude-haiku-4-5',
              apiKey: '',
            },
          }],
        }
      }
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
      executionMode: 'sync',
      apiKey: 'secret',
    })
    await clearLlmProviderOverride(db)
    expect(await getLlmProviderOverride(db)).toBeNull()
  })

  it('clears only the requested provider override scope', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmProviderOverride(db, {
      provider: 'claude-proxy',
      baseUrl: 'http://haex-claude-proxy:8080',
      model: 'claude-sonnet-5',
      executionMode: 'sync',
      apiKey: '',
    })
    await setLlmProviderOverride(db, {
      provider: 'gemini-native',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-flash-latest',
      executionMode: 'sync',
      apiKey: 'gemini-secret',
    }, 'translation')

    await clearLlmProviderOverride(db, 'translation')

    expect(await getLlmProviderOverride(db, 'translation')).toBeNull()
    expect(await getLlmProviderOverride(db, 'extraction')).toEqual({
      provider: 'claude-proxy',
      baseUrl: 'http://haex-claude-proxy:8080',
      model: 'claude-sonnet-5',
      executionMode: 'sync',
      apiKey: '',
    })
  })

  it('resolves assigned reusable provider profiles before legacy overrides', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmProviderOverride(db, {
      provider: 'claude-proxy',
      baseUrl: 'http://haex-claude-proxy:8080',
      model: 'claude-sonnet-5',
      executionMode: 'sync',
      apiKey: '',
    })
    await setLlmProviderProfileSettings(db, [
      {
        id: 'cheap-translation',
        name: 'Cheap translation',
        provider: 'gemini-native',
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'gemini-flash-latest',
        executionMode: 'batch',
        apiKey: 'gemini-secret',
      },
    ], { translation: 'cheap-translation' })

    expect(await getLlmProviderOverride(db, 'translation')).toEqual({
      provider: 'gemini-native',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-flash-latest',
      executionMode: 'sync',
      apiKey: 'gemini-secret',
    })
    expect(await getLlmProviderOverride(db, 'extraction')).toEqual({
      provider: 'claude-proxy',
      baseUrl: 'http://haex-claude-proxy:8080',
      model: 'claude-sonnet-5',
      executionMode: 'sync',
      apiKey: '',
    })
  })

  it('preserves profile api keys when an update omits apiKey', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmProviderProfileSettings(db, [
      {
        id: 'gemini',
        provider: 'gemini-native',
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'gemini-flash-latest',
        executionMode: 'sync',
        apiKey: 'secret',
      },
    ], { extraction: 'gemini' })

    await setLlmProviderProfileSettings(db, [
      {
        id: 'gemini',
        name: 'Gemini cheaper',
        provider: 'gemini-native',
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'gemini-flash-next',
        executionMode: 'sync',
      },
    ], { translation: 'gemini' })

    expect(await getLlmProviderProfileSettings(db)).toEqual({
      profiles: [{
        id: 'gemini',
        name: 'Gemini cheaper',
        provider: 'gemini-native',
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'gemini-flash-next',
        executionMode: 'sync',
        apiKey: 'secret',
      }],
      assignments: { translation: 'gemini' },
    })
  })

  it('rejects invalid reusable provider profile ids', async () => {
    const db = makeFakePool() as unknown as Pool
    await expect(setLlmProviderProfileSettings(db, [
      {
        id: 'bad id',
        provider: 'gemini-native',
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'gemini-flash-latest',
        executionMode: 'sync',
      },
    ], {})).rejects.toThrow('profile id: ungültiger Wert.')
  })

  it('rejects duplicate reusable provider profile ids', async () => {
    const db = makeFakePool() as unknown as Pool
    const profile = {
      id: 'gemini',
      provider: 'gemini-native' as const,
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-flash-latest',
      executionMode: 'sync' as const,
    }

    await expect(setLlmProviderProfileSettings(db, [profile, profile], {})).rejects.toThrow('profile id: doppelter Wert.')
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
