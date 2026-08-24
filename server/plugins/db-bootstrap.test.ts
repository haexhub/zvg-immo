import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runMigrations: vi.fn(),
  recordAppStart: vi.fn(),
  recordMigrationStatus: vi.fn(),
}))

vi.mock('../utils/db', () => ({ runMigrations: mocks.runMigrations }))
vi.mock('../utils/operations-status', () => ({
  recordAppStart: mocks.recordAppStart,
  recordMigrationStatus: mocks.recordMigrationStatus,
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

async function loadBootstrap() {
  let requestHandler: ((event: { path: string }) => Promise<void>) | undefined
  vi.stubGlobal('defineNitroPlugin', (plugin: (nitroApp: { hooks: { hook: (name: string, handler: typeof requestHandler) => void } }) => void) => {
    plugin({ hooks: { hook: (_name, handler) => { requestHandler = handler } } })
  })
  vi.stubGlobal('getRequestURL', (event: { path: string }) => ({ pathname: event.path }))
  vi.stubGlobal('createError', (input: Record<string, unknown>) => Object.assign(new Error(String(input.statusMessage)), input))
  await import('./db-bootstrap')
  return requestHandler!
}

describe('db bootstrap diagnostics', () => {
  it('records a successful migration and lets the diagnostics endpoint through', async () => {
    mocks.recordAppStart.mockResolvedValue(undefined)
    mocks.recordMigrationStatus.mockResolvedValue(undefined)
    mocks.runMigrations.mockResolvedValue(undefined)
    const requestHandler = await loadBootstrap()

    await vi.waitFor(() => expect(mocks.recordMigrationStatus).toHaveBeenLastCalledWith('ready'))
    await expect(requestHandler({ path: '/api/settings/operations' })).resolves.toBeUndefined()
    expect(mocks.runMigrations).toHaveBeenCalledOnce()
  })

  it('records migration failure while normal requests continue to receive 503', async () => {
    const migrationError = new Error('relation missing')
    mocks.recordAppStart.mockResolvedValue(undefined)
    mocks.recordMigrationStatus.mockResolvedValue(undefined)
    mocks.runMigrations.mockRejectedValue(migrationError)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const requestHandler = await loadBootstrap()

    await vi.waitFor(() => expect(mocks.recordMigrationStatus).toHaveBeenLastCalledWith('failed', migrationError))
    await expect(requestHandler({ path: '/api/regions' })).rejects.toMatchObject({ statusCode: 503 })
    await expect(requestHandler({ path: '/api/settings/operations' })).resolves.toBeUndefined()
  })
})
