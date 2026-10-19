import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  shouldSkipBootCrawl: vi.fn(),
  taskStartedWithin: vi.fn(),
  runTask: vi.fn(),
}))

vi.mock('../utils/boot-crawl-gate', () => ({
  shouldSkipBootCrawl: mocks.shouldSkipBootCrawl,
  taskStartedWithin: mocks.taskStartedWithin,
}))

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('defineNitroPlugin', (plugin: () => void) => plugin())
  vi.stubGlobal('runTask', mocks.runTask)
  mocks.shouldSkipBootCrawl.mockResolvedValue(false)
  mocks.taskStartedWithin.mockResolvedValue(false)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

async function bootAndWait() {
  await import('./enrich-bootstrap')
  await vi.advanceTimersByTimeAsync(60_000)
}

describe('enrich bootstrap', () => {
  it('skips the boot run when an enrich run started within the cron interval', async () => {
    mocks.taskStartedWithin.mockResolvedValue(true)

    await bootAndWait()

    expect(mocks.taskStartedWithin).toHaveBeenCalledWith('enrich', 6 * 60 * 60 * 1000, 'enrich-bootstrap')
    expect(mocks.runTask).not.toHaveBeenCalled()
  })

  it('runs enrich on a start after the last run aged past the cron interval', async () => {
    await bootAndWait()

    expect(mocks.runTask).toHaveBeenCalledWith('enrich')
  })

  it('still honours the scope-freshness gate', async () => {
    mocks.shouldSkipBootCrawl.mockResolvedValue(true)

    await bootAndWait()

    expect(mocks.runTask).not.toHaveBeenCalled()
  })
})
