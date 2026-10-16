import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPool } from '../db'
import { getLlmConcurrency, getLlmMaxPerRun } from '../app-settings'
import { resolveLlmConcurrency, resolveMaxLlmPerRun } from './reprocess-budget'

vi.mock('../db', () => ({ getPool: vi.fn() }))
vi.mock('../app-settings', () => ({ getLlmMaxPerRun: vi.fn(), getLlmConcurrency: vi.fn() }))

let envMaxPerRun = '20'
let envConcurrency = ''
vi.stubGlobal('useRuntimeConfig', () => ({ extractLlm: { maxPerRun: envMaxPerRun, concurrency: envConcurrency } }))

beforeEach(() => {
  envMaxPerRun = '20'
  envConcurrency = ''
  vi.mocked(getPool).mockReturnValue({} as never)
  vi.mocked(getLlmMaxPerRun).mockReset()
  vi.mocked(getLlmConcurrency).mockReset()
})

describe('resolveMaxLlmPerRun', () => {
  it('prefers the admin-set value over the env default', async () => {
    vi.mocked(getLlmMaxPerRun).mockResolvedValue(150)
    await expect(resolveMaxLlmPerRun()).resolves.toBe(150)
  })

  it('falls back to the env default when nothing is stored', async () => {
    vi.mocked(getLlmMaxPerRun).mockResolvedValue(null)
    await expect(resolveMaxLlmPerRun()).resolves.toBe(20)
  })

  it('falls back to the built-in default when env is unset too', async () => {
    envMaxPerRun = ''
    vi.mocked(getLlmMaxPerRun).mockResolvedValue(null)
    await expect(resolveMaxLlmPerRun()).resolves.toBe(1)
  })

  it('does not fail the run when the setting cannot be read, or without a DB', async () => {
    vi.mocked(getLlmMaxPerRun).mockRejectedValue(new Error('db down'))
    await expect(resolveMaxLlmPerRun()).resolves.toBe(20)
    vi.mocked(getPool).mockReturnValue(null as never)
    await expect(resolveMaxLlmPerRun()).resolves.toBe(20)
  })
})

describe('resolveLlmConcurrency', () => {
  it('prefers the admin-set lane count, then env, then 1', async () => {
    vi.mocked(getLlmConcurrency).mockResolvedValue(4)
    await expect(resolveLlmConcurrency()).resolves.toBe(4)

    vi.mocked(getLlmConcurrency).mockResolvedValue(null)
    envConcurrency = '3'
    await expect(resolveLlmConcurrency()).resolves.toBe(3)
    envConcurrency = ''
    await expect(resolveLlmConcurrency()).resolves.toBe(1)
  })

  it('stays sequential when the setting cannot be read', async () => {
    vi.mocked(getLlmConcurrency).mockRejectedValue(new Error('db down'))
    await expect(resolveLlmConcurrency()).resolves.toBe(1)
  })
})
