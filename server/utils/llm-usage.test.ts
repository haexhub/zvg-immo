import { describe, expect, it, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/node-postgres'
import { queryText } from '~/test-support/drizzle-query'
import { getDb, getPool } from './db'
import { recordLlmUsage, readLlmCostOverview } from './llm-usage'

vi.mock('./db', () => ({ getDb: vi.fn(), getPool: vi.fn() }))

describe('recordLlmUsage', () => {
  it('does nothing when no db is configured', async () => {
    vi.mocked(getDb).mockReturnValue(null)
    await expect(
      recordLlmUsage({
        task: 'extraction',
        executionMode: 'sync',
        source: 'reprocess',
        provider: 'claude-proxy',
        model: 'claude-haiku-4-5',
        profileId: null,
        platform: 'de-foo',
        externalId: '123',
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    ).resolves.toBeUndefined()
  })

  it('inserts a row with the computed cost for a known model', async () => {
    let captured: Record<string, unknown> | undefined
    const query = vi.fn(async (queryArg: unknown, params: unknown[] = []) => {
      const text = queryText(queryArg).replace(/\s+/g, ' ').trim().toLowerCase()
      if (text.startsWith('insert into "llm_usage_events"')) {
        captured = { params }
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`unexpected query: ${text}`)
    })
    vi.mocked(getDb).mockReturnValue(drizzle({ query } as never))

    await recordLlmUsage({
      task: 'extraction',
      executionMode: 'sync',
      source: 'reprocess',
      provider: 'claude-proxy',
      model: 'claude-haiku-4-5',
      profileId: 'p1',
      platform: 'de-foo',
      externalId: '123',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    })

    expect(query).toHaveBeenCalledTimes(1)
    // task, executionMode, source, provider, model, profileId, platform,
    // externalId, inputTokens, outputTokens, costUsd — cost is 1*1 + 5*1 = 6
    // for claude-haiku-4-5 (see llm-pricing.ts).
    expect(captured?.params).toContain(6)
  })

  it('logs and swallows a DB error instead of throwing', async () => {
    const query = vi.fn().mockRejectedValue(new Error('connection reset'))
    vi.mocked(getDb).mockReturnValue(drizzle({ query } as never))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      recordLlmUsage({
        task: 'translation',
        executionMode: 'sync',
        source: null,
        provider: 'gemini-native',
        model: 'gemini-flash-latest',
        profileId: null,
        platform: null,
        externalId: null,
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[llm-usage] record failed'))
    warn.mockRestore()
  })
})

describe('readLlmCostOverview', () => {
  it('returns an empty overview when no db is configured', async () => {
    vi.mocked(getPool).mockReturnValue(null)
    await expect(readLlmCostOverview()).resolves.toEqual({
      windowDays: 30,
      totalCostUsd: 0,
      totalUnpricedCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      todayCostUsd: 0,
      breakdown: [],
      daily: [],
    })
  })

  it('aggregates breakdown and daily rows into totals', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const query = vi.fn(async (queryArg: unknown) => {
      const text = queryText(queryArg)
      if (text.includes('GROUP BY task, provider, model, profile_id')) {
        return {
          rows: [
            {
              task: 'extraction',
              provider: 'claude-proxy',
              model: 'claude-haiku-4-5',
              profile_id: 'p1',
              call_count: '3',
              input_tokens: '3000',
              output_tokens: '900',
              cost_usd: 2.5,
              unpriced_call_count: '0',
            },
            {
              task: 'translation',
              provider: 'openrouter',
              model: 'some/unpriced-model',
              profile_id: null,
              call_count: '1',
              input_tokens: '500',
              output_tokens: '100',
              cost_usd: null,
              unpriced_call_count: '1',
            },
          ],
        }
      }
      if (text.includes("GROUP BY 1")) {
        return { rows: [{ day: today, cost_usd: 2.5, input_tokens: '3500', output_tokens: '1000' }] }
      }
      throw new Error(`unexpected query: ${text}`)
    })
    vi.mocked(getPool).mockReturnValue({ query } as never)

    const overview = await readLlmCostOverview()
    expect(overview.totalCostUsd).toBe(2.5)
    expect(overview.totalUnpricedCalls).toBe(1)
    expect(overview.totalInputTokens).toBe(3500)
    expect(overview.totalOutputTokens).toBe(1000)
    expect(overview.todayCostUsd).toBe(2.5)
    expect(overview.breakdown).toHaveLength(2)
    expect(overview.daily).toEqual([{ day: today, costUsd: 2.5, inputTokens: 3500, outputTokens: 1000 }])
  })
})
