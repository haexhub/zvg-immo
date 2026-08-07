import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/db', () => ({ getPool: vi.fn() }))
vi.mock('~/server/utils/app-settings', () => ({ setLlmProviderAssignments: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/llm-assignments PUT', () => {
  it('rejects with 503 when Postgres is not configured', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue(null)

    const handler = (await import('./llm-assignments.put')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler({})).rejects.toMatchObject({ statusCode: 503 })
  })

  it('rejects with 400 on an unparseable body', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    vi.stubGlobal('readBody', vi.fn(async () => { throw new Error('bad json') }))
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue({} as never)

    const handler = (await import('./llm-assignments.put')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
  })

  it('passes extraction/translation assignments and strategy through unchanged', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const body = { assignments: { extraction: ['p1', 'p2'], translation: ['p3'] }, strategy: 'round-robin' }
    vi.stubGlobal('readBody', vi.fn(async () => body))
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue({} as never)
    const { setLlmProviderAssignments } = await import('~/server/utils/app-settings')
    vi.mocked(setLlmProviderAssignments).mockResolvedValue({ assignments: body.assignments, strategy: 'round-robin' })

    const handler = (await import('./llm-assignments.put')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler({})).resolves.toEqual({ assignments: body.assignments, strategy: 'round-robin' })
    expect(setLlmProviderAssignments).toHaveBeenCalledWith({}, body.assignments, 'round-robin')
  })

  it('passes an insight-scoped assignment through the same as extraction/translation', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const body = { assignments: { 'usage-ideas': ['p1'] } }
    vi.stubGlobal('readBody', vi.fn(async () => body))
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue({} as never)
    const { setLlmProviderAssignments } = await import('~/server/utils/app-settings')
    vi.mocked(setLlmProviderAssignments).mockResolvedValue({ assignments: body.assignments, strategy: 'fallback' })

    const handler = (await import('./llm-assignments.put')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler({})).resolves.toEqual({ assignments: body.assignments, strategy: 'fallback' })
    expect(setLlmProviderAssignments).toHaveBeenCalledWith({}, { 'usage-ideas': ['p1'] }, undefined)
  })

  it('maps a save failure to a 500', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    vi.stubGlobal('readBody', vi.fn(async () => ({ assignments: {} })))
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue({} as never)
    const { setLlmProviderAssignments } = await import('~/server/utils/app-settings')
    vi.mocked(setLlmProviderAssignments).mockRejectedValue(new Error('db exploded'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const handler = (await import('./llm-assignments.put')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler({})).rejects.toMatchObject({ statusCode: 500 })
    expect(warnSpy).toHaveBeenCalled()
  })
})
