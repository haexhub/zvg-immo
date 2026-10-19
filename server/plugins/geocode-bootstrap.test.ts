import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ shouldSkipBootCrawl: vi.fn(async () => true) }))

vi.mock('../utils/boot-crawl-gate', () => ({ shouldSkipBootCrawl: mocks.shouldSkipBootCrawl }))

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.resetModules()
  vi.clearAllMocks()
})

async function boot(): Promise<ReturnType<typeof vi.fn>> {
  const runTask = vi.fn(async () => ({}))
  vi.stubGlobal('runTask', runTask)
  vi.stubGlobal('defineNitroPlugin', (plugin: () => void) => plugin())
  await import('./geocode-bootstrap')
  return runTask
}

describe('geocode bootstrap', () => {
  it('runs the geocode task after startup even when every crawl scope is warm', async () => {
    vi.useFakeTimers()
    vi.stubEnv('ZVG_SKIP_BOOT_TASKS', '')
    const runTask = await boot()
    expect(runTask).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5000)

    // Geocode no longer crawls, so the boot crawl gate must not hold it back.
    expect(mocks.shouldSkipBootCrawl).not.toHaveBeenCalled()
    expect(runTask).toHaveBeenCalledWith('geocode')
  })

  it('stays off when boot tasks are disabled', async () => {
    vi.useFakeTimers()
    vi.stubEnv('ZVG_SKIP_BOOT_TASKS', '1')
    const runTask = await boot()
    await vi.advanceTimersByTimeAsync(5000)
    expect(runTask).not.toHaveBeenCalled()
  })
})
