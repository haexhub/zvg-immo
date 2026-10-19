import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readExtractionLlmConfigChain } from '../utils/extract/llm-task-config'
import { recordTaskRunEnd } from '../utils/task-runs'

vi.mock('../utils/tasks/reprocess-run', () => ({ runReprocess: vi.fn() }))
vi.mock('../utils/extract/llm-task-config', () => ({
  MAX_LLM_FAILURES: 3,
  LLM_FAILURE_RETRY_COOLDOWN_HOURS: 24,
  readExtractionChainStrategy: vi.fn(),
  readExtractionLlmConfigChain: vi.fn(),
}))
vi.mock('../utils/task-runs', () => ({
  recordTaskRunStart: vi.fn(),
  recordTaskRunEnd: vi.fn(),
  recordTaskRunProgress: vi.fn(),
}))
vi.mock('../utils/automatic-task-gate', () => ({ isAutomaticLlmEnabled: vi.fn(async () => true) }))

vi.stubGlobal('defineTask', (definition: unknown) => definition)

const { runReprocess } = await import('../utils/tasks/reprocess-run')
const { default: reprocessTask, runReprocessTask } = await import('./reprocess')
const {
  DEFAULT_LOCKED_RETRY_PER_RUN,
  isPlainScheduledRun,
  readLockedRetryPerRun,
  runLockedRetrySlice,
} = await import('../utils/tasks/reprocess-locked-slice')

function result(overrides: Record<string, unknown> = {}) {
  return {
    candidates: 10, processed: 10, skipped: 0, llmCalls: 12, llmErrors: 0, rulesFalsified: 0, durationMs: 1000,
    ...overrides,
  }
}

function stubConfig(lockedRetryPerRun?: string) {
  vi.stubGlobal('useRuntimeConfig', () => ({
    extractLlm: lockedRetryPerRun === undefined ? { maxPerRun: '20' } : { maxPerRun: '20', lockedRetryPerRun },
  }))
}

beforeEach(() => {
  stubConfig()
  vi.mocked(readExtractionLlmConfigChain).mockResolvedValue([{ model: 'claude-haiku-5-5' }] as never)
  vi.mocked(runReprocess).mockResolvedValue(result() as never)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('readLockedRetryPerRun', () => {
  it('defaults when unset, empty or not a non-negative integer', () => {
    for (const raw of [undefined, '', '  ', 'abc', '-3', '2.5']) {
      stubConfig(raw)
      expect(readLockedRetryPerRun()).toBe(DEFAULT_LOCKED_RETRY_PER_RUN)
    }
  })

  it('honours an explicit value, including 0 to switch the slice off', () => {
    stubConfig('25')
    expect(readLockedRetryPerRun()).toBe(25)
    stubConfig('0')
    expect(readLockedRetryPerRun()).toBe(0)
  })
})

describe('isPlainScheduledRun', () => {
  it('accepts an empty payload and a plain cron trigger', () => {
    expect(isPlainScheduledRun({})).toBe(true)
    expect(isPlainScheduledRun({ trigger: 'cron' })).toBe(true)
  })

  it('rejects manual runs and anything scoped or mode-changing', () => {
    expect(isPlainScheduledRun({ trigger: 'manual' })).toBe(false)
    for (const options of [
      { country: 'de' }, { platform: 'zvg-portal' }, { externalId: '1' }, { caseNumber: 'x' },
      { force: true }, { limit: 5 }, { failedOnly: true }, { openOnly: true }, { batch: true },
    ]) {
      expect(isPlainScheduledRun(options)).toBe(false)
    }
  })
})

describe('runLockedRetrySlice', () => {
  it('retries only locked auctions past their failure backoff, bounded, bypassing the per-run budget', async () => {
    stubConfig('7')
    await expect(runLockedRetrySlice()).resolves.toMatchObject({ processed: 10 })
    expect(runReprocess).toHaveBeenCalledWith({
      failedOnly: true,
      ignoreBatchPending: true,
      ignoreLlmBudget: true,
      batch: false,
      limit: 7,
      trigger: 'cron',
      preserveCandidateOrder: true,
    }, undefined)
  })

  it('does nothing when switched off', async () => {
    stubConfig('0')
    await expect(runLockedRetrySlice()).resolves.toBeNull()
    expect(runReprocess).not.toHaveBeenCalled()
  })

  it('does nothing without a configured LLM chain (kill switch, no profile)', async () => {
    vi.mocked(readExtractionLlmConfigChain).mockResolvedValue([])
    await expect(runLockedRetrySlice()).resolves.toBeNull()
    expect(runReprocess).not.toHaveBeenCalled()
  })
})

describe('runReprocessTask locked slice', () => {
  it('runs the slice before the full pass on a plain scheduled run', async () => {
    const calls: string[] = []
    vi.mocked(runReprocess).mockImplementation((async (options: { failedOnly?: boolean }) => {
      calls.push(options.failedOnly ? 'slice' : 'full')
      return result()
    }) as never)

    await runReprocessTask({})

    expect(calls).toEqual(['slice', 'full'])
  })

  it('leaves scoped and manual runs alone', async () => {
    await runReprocessTask({ trigger: 'manual', failedOnly: true, limit: 5 })
    await runReprocessTask({ country: 'de' })

    expect(runReprocess).toHaveBeenCalledTimes(2)
    expect(vi.mocked(runReprocess).mock.calls.map(([options]) => options)).toEqual([
      { trigger: 'manual', failedOnly: true, limit: 5 },
      { country: 'de' },
    ])
  })

  it("surfaces the slice's rate-limit warning on the recorded run", async () => {
    vi.mocked(runReprocess)
      .mockResolvedValueOnce(result({ warning: 'LLM-Rate-Limit: claude-proxy/claude-haiku-5-5.' }) as never)
      .mockResolvedValueOnce(result() as never)

    await runReprocessTask({})

    expect(recordTaskRunEnd).toHaveBeenCalledWith('reprocess', expect.objectContaining({
      warning: 'LLM-Rate-Limit: claude-proxy/claude-haiku-5-5.',
    }))
  })

  it('keeps both warnings when the full pass reports one as well', async () => {
    vi.mocked(runReprocess)
      .mockResolvedValueOnce(result({ warning: 'slice-warning' }) as never)
      .mockResolvedValueOnce(result({ warning: 'full-warning' }) as never)

    await runReprocessTask({})

    expect(recordTaskRunEnd).toHaveBeenCalledWith('reprocess', expect.objectContaining({
      warning: 'slice-warning full-warning',
    }))
  })

  it('records and returns the combined slice and full-pass counters', async () => {
    const sliceResult = result({
      candidates: 7,
      processed: 5,
      skipped: 2,
      llmCalls: 6,
      llmErrors: 1,
      rulesFalsified: 2,
      durationMs: 250,
      lastLlmError: 'slice-error',
    })
    const fullResult = result({
      candidates: 20,
      processed: 18,
      skipped: 2,
      llmCalls: 4,
      llmErrors: 3,
      rulesFalsified: 1,
      durationMs: 900,
      lastLlmError: 'full-error',
    })
    vi.mocked(runReprocess).mockResolvedValueOnce(sliceResult as never).mockResolvedValueOnce(fullResult as never)

    const outcome = await runReprocessTask({})

    expect(outcome).toEqual({ result: {
      candidates: 27,
      processed: 23,
      skipped: 4,
      llmCalls: 10,
      llmErrors: 4,
      rulesFalsified: 3,
      durationMs: 1150,
      lastLlmError: 'full-error',
    } })
    expect(recordTaskRunEnd).toHaveBeenCalledWith('reprocess', {
      result: {
        candidates: 27,
        processed: 23,
        skipped: 4,
        llmCalls: 10,
        llmErrors: 4,
        rulesFalsified: 3,
        durationMs: 1150,
      },
      warning: undefined,
      llmError: 'full-error',
    })
  })
})

describe('reprocess task entry point', () => {
  // Nitro calls the default export, not runReprocessTask directly. A facade
  // that only re-exports the runner (no local binding) still passes every
  // test above but throws a ReferenceError here — and in production.
  it('runs a scheduled payload through the task runner', async () => {
    const task = reprocessTask as unknown as { run(event: { payload?: unknown }): Promise<unknown> }

    await expect(task.run({ payload: {} })).resolves.toMatchObject({ result: expect.objectContaining({ processed: 20 }) })

    // locked slice + full pass
    expect(runReprocess).toHaveBeenCalledTimes(2)
  })

  it('passes a manual payload on unchanged', async () => {
    const task = reprocessTask as unknown as { run(event: { payload?: unknown }): Promise<unknown> }

    await task.run({ payload: { trigger: 'manual', platform: 'zvg-portal' } })

    expect(vi.mocked(runReprocess).mock.calls.map(([options]) => options)).toEqual([
      { trigger: 'manual', platform: 'zvg-portal' },
    ])
  })
})
