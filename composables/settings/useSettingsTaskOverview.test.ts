import { computed, ref, type Ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./useSettingsError', () => ({
  useSettingsError: () => ({ normalizeSettingsError: (_err: unknown, fallback: string) => fallback }),
}))

type Status = 'idle' | 'running'

function overview(enrich: Status, external: Status) {
  const task = (status: Status) => ({ status, startedAt: null, finishedAt: null, lastResult: null, lastError: null })
  return {
    totalJobs: 0,
    totalRequests: 0,
    jobs: [],
    recentJobs: [],
    backlog: {},
    backlogByCountry: {},
    capabilities: {},
    enrichStatus: task(enrich),
    reprocessStatus: task('idle'),
    externalEnrichmentStatus: task(external),
  }
}

async function loadComposable(responses: unknown[]) {
  const fetchMock = vi.fn(() => {
    const next = responses.length > 1 ? responses.shift() : responses[0]
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
  })
  const state = new Map<string, Ref<unknown>>()
  vi.stubGlobal('$fetch', fetchMock)
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }))
  vi.stubGlobal('useState', (key: string, init: () => unknown) => {
    if (!state.has(key)) state.set(key, ref(init()))
    return state.get(key)
  })
  const { useSettingsTaskOverview } = await import('./useSettingsTaskOverview')
  return { fetchMock, overview: useSettingsTaskOverview() }
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useSettingsTaskOverview progress polling', () => {
  it('restarts the grace window when a new task is triggered while polling an earlier one', async () => {
    const { fetchMock, overview: tasks } = await loadComposable([
      overview('running', 'idle'),
      // Enrich finished, the freshly-triggered external enrichment has not
      // recorded "running" yet.
      overview('idle', 'idle'),
      overview('idle', 'idle'),
      overview('idle', 'running'),
      overview('idle', 'idle'),
    ])

    await tasks.loadLlmBatchJobs()
    tasks.startProgressPolling()

    await vi.advanceTimersByTimeAsync(9000)
    expect(tasks.llmBatchJobs.value?.externalEnrichmentStatus.status).toBe('running')

    await vi.advanceTimersByTimeAsync(3000)
    const callsWhenStopped = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(9000)
    expect(fetchMock.mock.calls.length).toBe(callsWhenStopped)
  })
})
