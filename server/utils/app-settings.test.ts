import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import {
  DEFAULT_ENABLED_COUNTRIES,
  DEFAULT_HIDE_RULES_ONLY_AUCTIONS,
  DEFAULT_LLM_EXECUTION_MODE,
  DEFAULT_LLM_MAX_TOKENS,
  clearLlmProviderOverride,
  deleteLlmProviderProfile,
  getAllLlmMaxTokens,
  getEnabledCountries,
  getHideRulesOnlyAuctions,
  getLlmMaxTokens,
  getLlmProviderProfileSettings,
  getLlmProviderOverride,
  getLlmProviderOverrideChain,
  setEnabledCountries,
  setHideRulesOnlyAuctions,
  setLlmMaxTokens,
  setLlmProviderAssignments,
  setLlmProviderProfiles,
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
    expect(await getLlmMaxTokens(db, 'usage-ideas')).toBe(DEFAULT_LLM_MAX_TOKENS['usage-ideas'])
    expect(await getLlmMaxTokens(db, 'translation')).toBe(DEFAULT_LLM_MAX_TOKENS.translation)
  })

  it('returns a previously written value', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmMaxTokens(db, 'usage-ideas', 2048)
    expect(await getLlmMaxTokens(db, 'usage-ideas')).toBe(2048)
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
    expect(await getLlmMaxTokens(db as unknown as Pool, 'usage-ideas')).toBe(1025)
  })
})

describe('getAllLlmMaxTokens', () => {
  it('mixes defaults and overrides for a partially configured set', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmMaxTokens(db, 'translation', 16_000)
    expect(await getAllLlmMaxTokens(db)).toEqual({
      extraction: DEFAULT_LLM_MAX_TOKENS.extraction,
      'usage-ideas': DEFAULT_LLM_MAX_TOKENS['usage-ideas'],
      'renovation-cost-estimate': DEFAULT_LLM_MAX_TOKENS['renovation-cost-estimate'],
      translation: 16_000,
    })
  })
})

describe('setLlmMaxTokens', () => {
  it('clamps a too-low value up to the minimum', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmMaxTokens(db, 'usage-ideas', 10)
    expect(await getLlmMaxTokens(db, 'usage-ideas')).toBe(256)
  })

  it('clamps a too-high value down to the maximum', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmMaxTokens(db, 'extraction', 1_000_000)
    expect(await getLlmMaxTokens(db, 'extraction')).toBe(32_768)
  })

  it('rounds a non-integer value', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmMaxTokens(db, 'usage-ideas', 1024.6)
    expect(await getLlmMaxTokens(db, 'usage-ideas')).toBe(1025)
  })

  it('overwrites a previously set value', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmMaxTokens(db, 'usage-ideas', 2048)
    await setLlmMaxTokens(db, 'usage-ideas', 3000)
    expect(await getLlmMaxTokens(db, 'usage-ideas')).toBe(3000)
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
    ], { translation: ['cheap-translation'] })

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

  it('still resolves a legacy single-string assignment stored before fallback chains existed', async () => {
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
    ], {})
    // Bypasses setLlmProviderAssignments (which always writes the array form)
    // to simulate a row written by the pre-chain code.
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())`,
      ['llm_provider_assignments', JSON.stringify({ extraction: 'gemini' })],
    )

    expect(await getLlmProviderOverride(db, 'extraction')).toMatchObject({ model: 'gemini-flash-latest' })
    expect(await getLlmProviderOverrideChain(db, 'extraction')).toEqual([
      expect.objectContaining({ model: 'gemini-flash-latest' }),
    ])
  })

  describe('getLlmProviderOverrideChain', () => {
    it('returns every assigned profile in order, for automatic fallback', async () => {
      const db = makeFakePool() as unknown as Pool
      await setLlmProviderProfileSettings(db, [
        {
          id: 'primary',
          provider: 'gemini-native',
          baseUrl: 'https://generativelanguage.googleapis.com',
          model: 'gemini-3.1-flash-lite',
          executionMode: 'sync',
          apiKey: 'secret',
        },
        {
          id: 'fallback',
          provider: 'claude-proxy',
          baseUrl: 'http://haex-claude-proxy:8080',
          model: 'claude-haiku-4-5-20251001',
          executionMode: 'sync',
          apiKey: '',
        },
      ], { extraction: ['primary', 'fallback'] })

      expect(await getLlmProviderOverrideChain(db, 'extraction')).toEqual([
        {
          provider: 'gemini-native',
          baseUrl: 'https://generativelanguage.googleapis.com',
          model: 'gemini-3.1-flash-lite',
          executionMode: 'sync',
          apiKey: 'secret',
        },
        {
          provider: 'claude-proxy',
          baseUrl: 'http://haex-claude-proxy:8080',
          model: 'claude-haiku-4-5-20251001',
          executionMode: 'sync',
          apiKey: '',
        },
      ])
      // getLlmProviderOverride still returns just the primary — existing
      // non-chain-aware callers (models.post.ts, the settings "effective"
      // preview, …) keep working unchanged.
      expect(await getLlmProviderOverride(db, 'extraction')).toMatchObject({ model: 'gemini-3.1-flash-lite' })
    })

    it('drops an assigned id whose profile was deleted, without breaking the rest of the chain', async () => {
      const db = makeFakePool() as unknown as Pool
      await setLlmProviderProfileSettings(db, [
        {
          id: 'fallback',
          provider: 'claude-proxy',
          baseUrl: 'http://haex-claude-proxy:8080',
          model: 'claude-haiku-4-5-20251001',
          executionMode: 'sync',
          apiKey: '',
        },
      ], { extraction: ['primary', 'fallback'] })

      expect(await getLlmProviderOverrideChain(db, 'extraction')).toEqual([
        expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }),
      ])
    })

    it('falls back to the legacy single override row when no profile is assigned', async () => {
      const db = makeFakePool() as unknown as Pool
      await setLlmProviderOverride(db, {
        provider: 'claude-proxy',
        baseUrl: 'http://haex-claude-proxy:8080',
        model: 'claude-sonnet-5',
        executionMode: 'sync',
        apiKey: '',
      })

      expect(await getLlmProviderOverrideChain(db, 'extraction')).toEqual([
        {
          provider: 'claude-proxy',
          baseUrl: 'http://haex-claude-proxy:8080',
          model: 'claude-sonnet-5',
          executionMode: 'sync',
          apiKey: '',
        },
      ])
    })

    it('returns an empty chain when nothing is configured at all', async () => {
      const db = makeFakePool() as unknown as Pool
      expect(await getLlmProviderOverrideChain(db, 'extraction')).toEqual([])
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
    ], { extraction: ['gemini'] })

    await setLlmProviderProfileSettings(db, [
      {
        id: 'gemini',
        name: 'Gemini cheaper',
        provider: 'gemini-native',
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'gemini-flash-next',
        executionMode: 'sync',
      },
    ], { translation: ['gemini'] })

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
      assignments: { translation: ['gemini'] },
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
      apiKey: 'secret',
    }

    await expect(setLlmProviderProfileSettings(db, [profile, profile], {})).rejects.toThrow('profile id: doppelter Wert.')
  })

  it('rejects a profile whose public endpoint needs an API key it does not have', async () => {
    const db = makeFakePool() as unknown as Pool
    await expect(setLlmProviderProfileSettings(db, [
      {
        id: 'translate',
        provider: 'gemini-native',
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'gemini-3.5-flash-lite',
        executionMode: 'sync',
      },
    ], {})).rejects.toThrow('apiKey: für diesen Provider erforderlich.')
  })

  it('rejects a whitespace-only key, which is as unusable as no key at all', async () => {
    const db = makeFakePool() as unknown as Pool
    await expect(setLlmProviderProfileSettings(db, [
      {
        id: 'translate',
        provider: 'gemini-native',
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'gemini-3.5-flash-lite',
        executionMode: 'sync',
        apiKey: '   ',
      },
    ], {})).rejects.toThrow('apiKey: für diesen Provider erforderlich.')
  })

  it('accepts a keyless profile pointing at an internal sidecar', async () => {
    const db = makeFakePool() as unknown as Pool
    const saved = await setLlmProviderProfileSettings(db, [
      {
        id: 'proxy',
        provider: 'claude-proxy',
        baseUrl: 'http://haex-claude-proxy:8080',
        model: 'claude-haiku-4-5-20251001',
        executionMode: 'sync',
      },
    ], {})
    expect(saved.profiles[0]?.apiKey).toBe('')
  })

  it('keeps a profile valid when the key is only preserved from storage', async () => {
    const db = makeFakePool() as unknown as Pool
    const stored = {
      id: 'gemini',
      provider: 'gemini-native' as const,
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-flash-latest',
      executionMode: 'sync' as const,
      apiKey: 'secret',
    }
    await setLlmProviderProfileSettings(db, [stored], {})

    // apiKey omitted = "leave the stored key untouched"; the guard must resolve
    // against that COALESCE, not reject the edit as keyless.
    const saved = await setLlmProviderProfileSettings(db, [{ ...stored, apiKey: undefined, model: 'gemini-flash-next' }], {})
    expect(saved.profiles[0]).toMatchObject({ model: 'gemini-flash-next', apiKey: 'secret' })
  })
})

describe('setLlmProviderProfiles / setLlmProviderAssignments / deleteLlmProviderProfile', () => {
  it('setLlmProviderProfiles saves profiles without touching existing assignments', async () => {
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
    ], { extraction: ['gemini'] })

    await setLlmProviderProfiles(db, [
      {
        id: 'gemini',
        name: 'Gemini renamed',
        provider: 'gemini-native',
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'gemini-flash-latest',
        executionMode: 'sync',
      },
    ])

    expect(await getLlmProviderProfileSettings(db)).toEqual({
      profiles: [{
        id: 'gemini',
        name: 'Gemini renamed',
        provider: 'gemini-native',
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'gemini-flash-latest',
        executionMode: 'sync',
        apiKey: 'secret',
      }],
      assignments: { extraction: ['gemini'] },
    })
  })

  it('setLlmProviderAssignments updates assignments without touching profiles', async () => {
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
    ], {})

    const saved = await setLlmProviderAssignments(db, { extraction: ['gemini'], translation: ['gemini'] })

    expect(saved).toEqual({ extraction: ['gemini'], translation: ['gemini'] })
    expect(await getLlmProviderProfileSettings(db)).toEqual({
      profiles: [{
        id: 'gemini',
        name: 'gemini-native',
        provider: 'gemini-native',
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'gemini-flash-latest',
        executionMode: 'sync',
        apiKey: 'secret',
      }],
      assignments: { extraction: ['gemini'], translation: ['gemini'] },
    })
  })

  it('setLlmProviderAssignments drops assignments referencing an unknown profile id', async () => {
    const db = makeFakePool() as unknown as Pool
    expect(await setLlmProviderAssignments(db, { extraction: ['does-not-exist'] })).toEqual({})
  })

  it('setLlmProviderAssignments dedupes and caps an oversized fallback chain', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmProviderProfileSettings(db, [
      'a', 'b', 'c', 'd', 'e', 'f',
    ].map((id) => ({
      id,
      provider: 'claude-proxy' as const,
      baseUrl: 'http://haex-claude-proxy:8080',
      model: `model-${id}`,
      executionMode: 'sync' as const,
      apiKey: '',
    })), {})

    const saved = await setLlmProviderAssignments(db, { extraction: ['a', 'b', 'a', 'c', 'd', 'e', 'f'] })

    expect(saved).toEqual({ extraction: ['a', 'b', 'c', 'd', 'e'] })
  })

  it('deleteLlmProviderProfile removes the profile and prunes its assignments', async () => {
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
      {
        id: 'claude',
        provider: 'claude-proxy',
        baseUrl: 'http://haex-claude-proxy:8080',
        model: 'claude-sonnet-5',
        executionMode: 'sync',
        apiKey: '',
      },
    ], { extraction: ['gemini'], translation: ['claude'] })

    const result = await deleteLlmProviderProfile(db, 'gemini')

    expect(result.profiles.map((profile) => profile.id)).toEqual(['claude'])
    expect(result.assignments).toEqual({ translation: ['claude'] })
    expect(await getLlmProviderProfileSettings(db)).toEqual({
      profiles: [{
        id: 'claude',
        name: 'claude-proxy',
        provider: 'claude-proxy',
        baseUrl: 'http://haex-claude-proxy:8080',
        model: 'claude-sonnet-5',
        executionMode: 'sync',
        apiKey: '',
      }],
      assignments: { translation: ['claude'] },
    })
  })

  it('deleteLlmProviderProfile is a no-op for an unknown profile id', async () => {
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
    ], { extraction: ['gemini'] })

    const result = await deleteLlmProviderProfile(db, 'does-not-exist')

    expect(result.profiles.map((profile) => profile.id)).toEqual(['gemini'])
    expect(result.assignments).toEqual({ extraction: ['gemini'] })
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
