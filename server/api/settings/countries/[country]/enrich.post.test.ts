import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/crawlers/registry', () => ({
  ensureEnabledCountriesLoaded: vi.fn(),
  isCountryEnabled: vi.fn(() => true),
  listRegisteredCountries: vi.fn(() => [{ code: 'de', name: 'Deutschland' }]),
}))
vi.mock('~/server/tasks/reprocess', () => ({ runReprocessTask: vi.fn(async () => ({})) }))
vi.mock('~/server/tasks/enrich', () => ({ runEnrichTask: vi.fn() }))
vi.mock('~/server/tasks/external-enrichment', () => ({ runExternalEnrichmentTask: vi.fn(async () => ({})) }))

async function loadHandler(runEnrich: () => Promise<unknown>) {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getRouterParam', () => 'de')
  vi.stubGlobal('readBody', async () => ({}))
  vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
  const { runEnrichTask } = await import('~/server/tasks/enrich')
  vi.mocked(runEnrichTask).mockImplementation(runEnrich as never)
  const { runExternalEnrichmentTask } = await import('~/server/tasks/external-enrichment')
  const handler = (await import('./enrich.post')).default as unknown as (event: unknown) => Promise<unknown>
  return { handler, runEnrichTask: vi.mocked(runEnrichTask), runExternalEnrichmentTask: vi.mocked(runExternalEnrichmentTask) }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/countries/[country]/enrich', () => {
  it('answers before the crawl finishes and only then starts the follow-ups', async () => {
    const { runReprocessTask } = await import('~/server/tasks/reprocess')
    let finishCrawl!: () => void
    const { handler, runEnrichTask, runExternalEnrichmentTask } = await loadHandler(async () => {
      await new Promise<void>((resolve) => { finishCrawl = resolve })
      return {}
    })

    await expect(handler({})).resolves.toEqual({ started: true })
    expect(runEnrichTask).toHaveBeenCalledWith({ country: 'de', force: true, recordCrawlScope: true, trigger: 'manual' })
    expect(runReprocessTask).not.toHaveBeenCalled()
    expect(runExternalEnrichmentTask).not.toHaveBeenCalled()

    finishCrawl()
    await vi.waitFor(() => expect(runReprocessTask).toHaveBeenCalledWith({ country: 'de', force: false, trigger: 'manual' }))
    expect(runExternalEnrichmentTask).toHaveBeenCalledWith({ country: 'de', trigger: 'manual' })
  })

  it('keeps a failed crawl out of the HTTP response and skips the follow-ups', async () => {
    const { runReprocessTask } = await import('~/server/tasks/reprocess')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { handler, runEnrichTask, runExternalEnrichmentTask } = await loadHandler(async () => { throw new Error('boom') })

    await expect(handler({})).resolves.toEqual({ started: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runEnrichTask).toHaveBeenCalledTimes(1)
    expect(runReprocessTask).not.toHaveBeenCalled()
    expect(runExternalEnrichmentTask).not.toHaveBeenCalled()
  })
})
