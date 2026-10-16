import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/auction-admin-trial', () => ({
  validateAdminTrialReprocess: vi.fn(),
  runAdminTrialReprocess: vi.fn(),
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('POST /api/settings/auction/[platform]/[id]/reprocess', () => {
  it('rejects an unsafe platform/id segment', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getRouterParam', (_event: unknown, name: string) => (name === 'platform' ? '../etc' : '7265'))
    vi.stubGlobal('readBody', async () => ({ profileId: 'p1' }))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const handler = (await import('./reprocess.post')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
  })

  it('400s when profileId is missing', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getRouterParam', (_event: unknown, name: string) => (name === 'platform' ? 'zvg-portal' : '7265'))
    vi.stubGlobal('readBody', async () => ({}))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const handler = (await import('./reprocess.post')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
  })

  it('400s on an unknown profile', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getRouterParam', (_event: unknown, name: string) => (name === 'platform' ? 'zvg-portal' : '7265'))
    vi.stubGlobal('readBody', async () => ({ profileId: 'nope' }))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const { validateAdminTrialReprocess } = await import('~/server/utils/auction-admin-trial')
    vi.mocked(validateAdminTrialReprocess).mockResolvedValue({ ok: false, reason: 'unknown_profile' })

    const handler = (await import('./reprocess.post')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
  })

  it('404s on an unknown identity', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getRouterParam', (_event: unknown, name: string) => (name === 'platform' ? 'zvg-portal' : 'missing'))
    vi.stubGlobal('readBody', async () => ({ profileId: 'profile-1' }))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const { validateAdminTrialReprocess } = await import('~/server/utils/auction-admin-trial')
    vi.mocked(validateAdminTrialReprocess).mockResolvedValue({ ok: false, reason: 'not_found' })

    const handler = (await import('./reprocess.post')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 404 })
  })

  it('detaches the run and returns started:true', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getRouterParam', (_event: unknown, name: string) => (name === 'platform' ? 'zvg-portal' : '7265'))
    vi.stubGlobal('readBody', async () => ({ profileId: 'profile-1' }))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const { validateAdminTrialReprocess, runAdminTrialReprocess } = await import('~/server/utils/auction-admin-trial')
    vi.mocked(validateAdminTrialReprocess).mockResolvedValue({ ok: true })
    let resolveRun: () => void = () => {}
    vi.mocked(runAdminTrialReprocess).mockReturnValue(new Promise((resolve) => { resolveRun = resolve as never }))

    const handler = (await import('./reprocess.post')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toEqual({ started: true })
    expect(runAdminTrialReprocess).toHaveBeenCalledWith('zvg-portal', '7265', 'profile-1')
    resolveRun()
  })
})
