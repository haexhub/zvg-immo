import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import {
  DEFAULT_ENABLED_COUNTRIES,
  DEFAULT_AUTOMATIC_CRAWLING_ENABLED,
  DEFAULT_AUTOMATIC_LLM_ENABLED,
  DEFAULT_HIDE_RULES_ONLY_AUCTIONS,
  DEFAULT_LLM_EXECUTION_MODE,
  DEFAULT_LLM_KILL_SWITCH,
  DEFAULT_LLM_MAX_TOKENS,
  clearLlmProviderOverride,
  deleteLlmProviderProfile,
  getAllLlmMaxTokens,
  getEnabledCountries,
  getAutomaticCrawlingEnabled,
  getAutomaticLlmEnabled,
  getHideRulesOnlyAuctions,
  getLlmKillSwitch,
  getLlmMaxTokens,
  getLlmProviderProfileSettings,
  getLlmProviderOverride,
  getLlmProviderOverrideChain,
  setEnabledCountries,
  setAutomaticCrawlingEnabled,
  setAutomaticLlmEnabled,
  setHideRulesOnlyAuctions,
  setLlmKillSwitch,
  setLlmMaxTokens,
  getLlmExtractionChainStrategy,
  setLlmProviderAssignments,
  setLlmProviderProfiles,
  setLlmProviderProfileSettings,
  setLlmProviderOverride,
} from './app-settings'
import { queryText } from '~/test-support/drizzle-query'

/** Minimal in-memory stand-in for the `pg` Pool, matching the exact queries
 *  app-settings.ts issues (checked via the compiled SQL Drizzle sends to
 *  `client.query()`), mirroring the fake pool in content-translation.test.ts.
 *  app-settings.ts wraps this same Pool-shaped object in `drizzle()` itself
 *  per call, so the constructor name below must look like a real `pg.Pool`
 *  for `db.transaction()`'s pool-vs-client detection to take the
 *  connect()-and-release branch. */
function makeFakePool() {
  const rows = new Map<string, unknown>()

  const query = async (queryArg: unknown, params: unknown[] = []) => {
    const text = queryText(queryArg)
    const n = text.replace(/\s+/g, ' ').trim().toLowerCase()
    if (n === 'begin' || n === 'commit' || n === 'rollback') {
      return { rows: [], rowCount: null }
    }
    if (n.startsWith('select "value" from "app_settings"')) {
      const [key] = params as [string]
      return rows.has(key) ? { rows: [[rows.get(key)]] } : { rows: [] }
    }
    if (n.startsWith('select "key", "value" from "app_settings"')) {
      const keys = params as string[]
      return { rows: keys.filter((k) => rows.has(k)).map((k) => [k, rows.get(k)]) }
    }
    if (n.startsWith('insert into "app_settings"')) {
      // writeSetting()/the transactional upserts: [key, value, updatedAt, value, updatedAt] —
      // value arrives JSON-stringified (Drizzle's jsonb mapToDriverValue).
      const [key, value] = params as [string, string]
      rows.set(key, JSON.parse(value))
      return { rows: [], rowCount: 1 }
    }
    if (n.startsWith('insert into app_settings (key, value, updated_at) values ($1, $2, now())')) {
      // The legacy-row seed below, written with hand-rolled SQL bypassing
      // app-settings.ts entirely (simulating a pre-chain stored row).
      const [key, value] = params as [string, string]
      rows.set(key, JSON.parse(value))
      return { rows: [], rowCount: 1 }
    }
    if (n.startsWith('insert into app_settings (key, value, updated_at)')) {
      // setLlmProviderOverride's atomic upsert (raw sql fragment, not the
      // query builder): [key, provider, baseUrl, model, executionMode|null,
      // defaultExecutionMode, apiKey|null, ...same 6 again for the SET
      // clause]. Emulates the SQL's COALESCEs without a real jsonb engine.
      const [key, provider, baseUrl, model, executionMode, defaultExecutionMode, apiKey] = params as [
        string,
        string,
        string,
        string,
        string | null,
        string,
        string | null,
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
    if (n.startsWith('delete from "app_settings"')) {
      const [key] = params as [string]
      const existed = rows.delete(key)
      return { rows: [], rowCount: existed ? 1 : 0 }
    }
    throw new Error(`unexpected query: ${text}`)
  }

  function MockPool() {}
  return Object.assign(new (MockPool as unknown as new () => object)(), {
    query: query as unknown as Pool['query'],
    connect: async () => ({
      query: query as unknown as Pool['query'],
      release: () => undefined,
    }),
  }) as unknown as Pool
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
    ;(db as unknown as { query: (queryArg: unknown) => Promise<unknown> }).query = async (queryArg: unknown) => {
      if (queryText(queryArg).toLowerCase().startsWith('select "value"')) return { rows: [['de,se']] }
      throw new Error('unexpected')
    }
    expect(await getEnabledCountries(db)).toEqual(DEFAULT_ENABLED_COUNTRIES)
  })
})

describe('getLlmMaxTokens', () => {
  it('falls back to the default when no row exists', async () => {
    const db = makeFakePool() as unknown as Pool
    expect(await getLlmMaxTokens(db, 'extraction')).toBe(DEFAULT_LLM_MAX_TOKENS.extraction)
    expect(await getLlmMaxTokens(db, 'translation')).toBe(DEFAULT_LLM_MAX_TOKENS.translation)
  })

  // 'custom-kind' stands in for any kind beyond extraction/translation
  // (LlmMaxTokensKind accepts any string) — it has no configured default, so
  // the fallback is the hard floor (MIN_MAX_TOKENS), not a per-kind default.
  it('falls back to the floor for a kind with no configured default', async () => {
    const db = makeFakePool() as unknown as Pool
    expect(await getLlmMaxTokens(db, 'custom-kind')).toBe(256)
  })

  it('returns a previously written value', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmMaxTokens(db, 'custom-kind', 2048)
    expect(await getLlmMaxTokens(db, 'custom-kind')).toBe(2048)
  })

  it('falls back to the default on a malformed value', async () => {
    const db = makeFakePool()
    ;(db as unknown as { query: (queryArg: unknown) => Promise<unknown> }).query = async (queryArg: unknown) => {
      if (queryText(queryArg).toLowerCase().startsWith('select "value"')) return { rows: [['not-a-number']] }
      throw new Error('unexpected')
    }
    expect(await getLlmMaxTokens(db, 'extraction')).toBe(DEFAULT_LLM_MAX_TOKENS.extraction)
  })

  it('clamps a stored out-of-range value that bypassed setLlmMaxTokens', async () => {
    const db = makeFakePool()
    ;(db as unknown as { query: (queryArg: unknown) => Promise<unknown> }).query = async (queryArg: unknown) => {
      if (queryText(queryArg).toLowerCase().startsWith('select "value"')) return { rows: [[1_000_000]] }
      throw new Error('unexpected')
    }
    expect(await getLlmMaxTokens(db, 'extraction')).toBe(32_768)
  })

  it('rounds a stored fractional value that bypassed setLlmMaxTokens', async () => {
    const db = makeFakePool()
    ;(db as unknown as { query: (queryArg: unknown) => Promise<unknown> }).query = async (queryArg: unknown) => {
      if (queryText(queryArg).toLowerCase().startsWith('select "value"')) return { rows: [[1024.6]] }
      throw new Error('unexpected')
    }
    expect(await getLlmMaxTokens(db, 'custom-kind')).toBe(1025)
  })
})

describe('getAllLlmMaxTokens', () => {
  it('mixes defaults and overrides for a partially configured set', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmMaxTokens(db, 'translation', 16_000)
    expect(await getAllLlmMaxTokens(db)).toEqual({
      extraction: DEFAULT_LLM_MAX_TOKENS.extraction,
      translation: 16_000,
    })
  })
})

describe('setLlmMaxTokens', () => {
  it('clamps a too-low value up to the minimum', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmMaxTokens(db, 'custom-kind', 10)
    expect(await getLlmMaxTokens(db, 'custom-kind')).toBe(256)
  })

  it('clamps a too-high value down to the maximum', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmMaxTokens(db, 'extraction', 1_000_000)
    expect(await getLlmMaxTokens(db, 'extraction')).toBe(32_768)
  })

  it('rounds a non-integer value', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmMaxTokens(db, 'custom-kind', 1024.6)
    expect(await getLlmMaxTokens(db, 'custom-kind')).toBe(1025)
  })

  it('overwrites a previously set value', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmMaxTokens(db, 'custom-kind', 2048)
    await setLlmMaxTokens(db, 'custom-kind', 3000)
    expect(await getLlmMaxTokens(db, 'custom-kind')).toBe(3000)
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
    ;(db as unknown as { query: (queryArg: unknown) => Promise<unknown> }).query = async (queryArg: unknown) => {
      if (queryText(queryArg).toLowerCase().startsWith('select "value"')) {
        return { rows: [[{ provider: 'not-a-real-provider' }]] }
      }
      throw new Error('unexpected')
    }
    expect(await getLlmProviderOverride(db)).toBeNull()
  })

  it('returns null when a stored provider override is missing executionMode', async () => {
    const db = makeFakePool()
    ;(db as unknown as { query: (queryArg: unknown) => Promise<unknown> }).query = async (queryArg: unknown) => {
      if (queryText(queryArg).toLowerCase().startsWith('select "value"')) {
        return {
          rows: [[{
            provider: 'claude-proxy',
            baseUrl: 'http://haex-claude-proxy:8080',
            model: 'claude-haiku-4-5',
            apiKey: '',
          }]],
        }
      }
      throw new Error('unexpected')
    }
    expect(await getLlmProviderOverride(db)).toBeNull()
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
      profileId: 'cheap-translation',
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
          profileId: 'primary',
        },
        {
          provider: 'claude-proxy',
          baseUrl: 'http://haex-claude-proxy:8080',
          model: 'claude-haiku-4-5-20251001',
          executionMode: 'sync',
          apiKey: '',
          profileId: 'fallback',
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

    expect(saved.assignments).toEqual({ extraction: ['gemini'], translation: ['gemini'] })
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
    expect((await setLlmProviderAssignments(db, { extraction: ['does-not-exist'] })).assignments).toEqual({})
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

    expect(saved.assignments).toEqual({ extraction: ['a', 'b', 'c', 'd', 'e'] })
  })

  it('setLlmProviderAssignments stores a valid chain strategy and preserves it when omitted', async () => {
    const db = makeFakePool() as unknown as Pool
    expect(await getLlmExtractionChainStrategy(db)).toBe('fallback')

    expect((await setLlmProviderAssignments(db, {}, 'round-robin')).strategy).toBe('round-robin')
    expect(await getLlmExtractionChainStrategy(db)).toBe('round-robin')

    // Omitted (or garbage — the PUT body is untrusted) must not silently reset
    // the strategy to the default, same preserve-on-omit contract as apiKey.
    expect((await setLlmProviderAssignments(db, {})).strategy).toBe('round-robin')
    expect((await setLlmProviderAssignments(db, {}, 'nonsense')).strategy).toBe('round-robin')
    expect(await getLlmExtractionChainStrategy(db)).toBe('round-robin')
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

describe('getLlmKillSwitch', () => {
  it('defaults to false when no row exists', async () => {
    const db = makeFakePool() as unknown as Pool
    expect(await getLlmKillSwitch(db)).toBe(DEFAULT_LLM_KILL_SWITCH)
  })

  it('returns a previously written value', async () => {
    const db = makeFakePool() as unknown as Pool
    await setLlmKillSwitch(db, true)
    expect(await getLlmKillSwitch(db)).toBe(true)
  })
})

describe('automatic processing preferences', () => {
  it('defaults both automatic pipelines to enabled', async () => {
    const db = makeFakePool() as unknown as Pool
    await expect(getAutomaticCrawlingEnabled(db)).resolves.toBe(DEFAULT_AUTOMATIC_CRAWLING_ENABLED)
    await expect(getAutomaticLlmEnabled(db)).resolves.toBe(DEFAULT_AUTOMATIC_LLM_ENABLED)
  })

  it('persists crawler and LLM automation independently', async () => {
    const db = makeFakePool() as unknown as Pool
    await setAutomaticCrawlingEnabled(db, false)
    await setAutomaticLlmEnabled(db, false)
    await expect(getAutomaticCrawlingEnabled(db)).resolves.toBe(false)
    await expect(getAutomaticLlmEnabled(db)).resolves.toBe(false)
  })
})
