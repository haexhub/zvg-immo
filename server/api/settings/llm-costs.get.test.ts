import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/llm-usage', () => ({ readLlmCostOverview: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

async function loadHandler(query: Record<string, unknown>) {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getQuery', () => query)
  return (await import('./llm-costs.get')).default as (event: unknown) => Promise<unknown>
}

describe('/api/settings/llm-costs', () => {
  it('defaults to a 30-day window', async () => {
    const handler = await loadHandler({})
    const { readLlmCostOverview } = await import('~/server/utils/llm-usage')
    vi.mocked(readLlmCostOverview).mockResolvedValue({
      windowDays: 30, totalCostUsd: 0, totalUnpricedCalls: 0, totalInputTokens: 0, totalOutputTokens: 0,
      todayCostUsd: 0, breakdown: [], daily: [],
    })

    await handler({})

    expect(readLlmCostOverview).toHaveBeenCalledWith(30)
  })

  it('forwards a valid ?days override', async () => {
    const handler = await loadHandler({ days: '7' })
    const { readLlmCostOverview } = await import('~/server/utils/llm-usage')
    vi.mocked(readLlmCostOverview).mockResolvedValue({
      windowDays: 7, totalCostUsd: 0, totalUnpricedCalls: 0, totalInputTokens: 0, totalOutputTokens: 0,
      todayCostUsd: 0, breakdown: [], daily: [],
    })

    await handler({})

    expect(readLlmCostOverview).toHaveBeenCalledWith(7)
  })

  it('falls back to the default for an out-of-range or invalid ?days', async () => {
    const { readLlmCostOverview } = await import('~/server/utils/llm-usage')
    vi.mocked(readLlmCostOverview).mockResolvedValue({
      windowDays: 30, totalCostUsd: 0, totalUnpricedCalls: 0, totalInputTokens: 0, totalOutputTokens: 0,
      todayCostUsd: 0, breakdown: [], daily: [],
    })

    const handlerA = await loadHandler({ days: '0' })
    await handlerA({})
    expect(readLlmCostOverview).toHaveBeenLastCalledWith(30)

    const handlerB = await loadHandler({ days: '9999' })
    await handlerB({})
    expect(readLlmCostOverview).toHaveBeenLastCalledWith(30)

    const handlerC = await loadHandler({ days: 'nonsense' })
    await handlerC({})
    expect(readLlmCostOverview).toHaveBeenLastCalledWith(30)
  })
})
