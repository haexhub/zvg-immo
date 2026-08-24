import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAppRuntimeStatus: vi.fn(),
  getHostOperationsStatus: vi.fn(),
}))

vi.mock('../../utils/operations-status', () => mocks)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/operations', () => {
  it('combines the filesystem-backed app and host status', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    mocks.getAppRuntimeStatus.mockResolvedValue({ migration: { status: 'failed' } })
    mocks.getHostOperationsStatus.mockResolvedValue({ available: true })

    const handler = (await import('./operations.get')).default as unknown as () => Promise<Record<string, unknown>>
    const result = await handler()

    expect(result.app).toEqual({ migration: { status: 'failed' } })
    expect(result.host).toEqual({ available: true })
    expect(result.now).toEqual(expect.any(String))
  })
})
