import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPool } from '../db'
import { getLlmMaxPerRun } from '../app-settings'
import { resolveMaxLlmPerRun } from './reprocess-input'

vi.mock('../db', () => ({ getPool: vi.fn() }))
vi.mock('../app-settings', () => ({ getLlmMaxPerRun: vi.fn() }))
vi.mock('../../crawlers/registry', () => ({
  ensureEnabledCountriesLoaded: vi.fn(),
  getEnabledCountryCodes: vi.fn(() => []),
  isCountryEnabled: vi.fn(() => true),
}))

let envMaxPerRun = '20'
vi.stubGlobal('useRuntimeConfig', () => ({ extractLlm: { maxPerRun: envMaxPerRun } }))

beforeEach(() => {
  envMaxPerRun = '20'
  vi.mocked(getPool).mockReturnValue({} as never)
  vi.mocked(getLlmMaxPerRun).mockReset()
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
