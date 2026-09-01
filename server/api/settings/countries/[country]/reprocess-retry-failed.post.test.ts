import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/crawlers/registry', () => ({
  ensureEnabledCountriesLoaded: vi.fn(),
  isCountryEnabled: vi.fn(() => true),
  listRegisteredCountries: vi.fn(() => [{ code: 'de', name: 'Deutschland' }]),
}))
vi.mock('~/server/tasks/reprocess', () => ({ runReprocessTask: vi.fn() }))

async function loadHandler() {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getRouterParam', () => 'de')
  vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
  return (await import('./reprocess-retry-failed.post')).default as unknown as (event: unknown) => Promise<unknown>
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/countries/[country]/reprocess-retry-failed', () => {
  it('passes the failed-only retry payload to the direct task runner', async () => {
    const { runReprocessTask } = await import('~/server/tasks/reprocess')
    vi.mocked(runReprocessTask).mockResolvedValue({ result: {} } as never)
    const handler = await loadHandler()

    await expect(handler({})).resolves.toEqual({ started: true })
    expect(runReprocessTask).toHaveBeenCalledWith({
      country: 'de',
      force: false,
      ignoreCooldown: true,
      ignoreBatchPending: true,
      failedOnly: true,
      ignoreLlmBudget: true,
      trigger: 'manual',
    })
  })

  it('keeps a background task failure out of the HTTP response', async () => {
    const { runReprocessTask } = await import('~/server/tasks/reprocess')
    vi.mocked(runReprocessTask).mockRejectedValue(new Error('boom'))
    const handler = await loadHandler()

    await expect(handler({})).resolves.toEqual({ started: true })
  })
})
