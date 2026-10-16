import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/tasks/reprocess', () => ({ runReprocessTask: vi.fn() }))
vi.mock('~/server/utils/exclusive-task', () => ({ isTaskActive: vi.fn(() => false) }))

async function loadHandler(body: unknown) {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('readBody', async () => body)
  vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
  return (await import('./reprocess.post')).default as unknown as (event: unknown) => Promise<unknown>
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.resetAllMocks()
})

describe('/api/settings/reprocess', () => {
  it('answers before the run finishes', async () => {
    const { runReprocessTask } = await import('~/server/tasks/reprocess')
    vi.mocked(runReprocessTask).mockReturnValue(new Promise(() => {}))
    const handler = await loadHandler({ limit: 5, country: 'de', batch: true })

    await expect(handler({})).resolves.toEqual({ started: true })
    expect(runReprocessTask).toHaveBeenCalledWith({
      limit: 5,
      force: true,
      country: 'de',
      platform: undefined,
      externalId: undefined,
      caseNumber: undefined,
      batch: true,
      trigger: 'manual',
    })
  })

  it('retryFailed retries only locked auctions, bounded and without forcing', async () => {
    const { runReprocessTask } = await import('~/server/tasks/reprocess')
    vi.mocked(runReprocessTask).mockReturnValue(new Promise(() => {}))
    const handler = await loadHandler({ limit: 25, platform: 'zvg-portal', retryFailed: true, force: true, batch: true })

    await expect(handler({})).resolves.toEqual({ started: true })
    expect(runReprocessTask).toHaveBeenCalledWith({
      limit: 25,
      force: false,
      country: undefined,
      platform: 'zvg-portal',
      externalId: undefined,
      caseNumber: undefined,
      batch: false,
      trigger: 'manual',
      failedOnly: true,
      ignoreCooldown: true,
      ignoreBatchPending: true,
      ignoreLlmBudget: true,
    })
  })

  it('retryFailed still requires a valid limit', async () => {
    const { runReprocessTask } = await import('~/server/tasks/reprocess')
    const handler = await loadHandler({ retryFailed: true })

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
    expect(runReprocessTask).not.toHaveBeenCalled()
  })

  it('rejects a request while another reprocess is active', async () => {
    const { isTaskActive } = await import('~/server/utils/exclusive-task')
    vi.mocked(isTaskActive).mockReturnValue(true)
    const { runReprocessTask } = await import('~/server/tasks/reprocess')
    const handler = await loadHandler({ limit: 1, retryFailed: true })

    await expect(handler({})).rejects.toMatchObject({ statusCode: 409 })
    expect(runReprocessTask).not.toHaveBeenCalled()
  })

  it('keeps a background task failure out of the HTTP response', async () => {
    const { runReprocessTask } = await import('~/server/tasks/reprocess')
    vi.mocked(runReprocessTask).mockRejectedValue(new Error('boom'))
    const handler = await loadHandler({ limit: 1 })

    await expect(handler({})).resolves.toEqual({ started: true })
  })

  it('rejects an out-of-range limit without starting a run', async () => {
    const { runReprocessTask } = await import('~/server/tasks/reprocess')
    const handler = await loadHandler({ limit: 201 })

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
    expect(runReprocessTask).not.toHaveBeenCalled()
  })
})
