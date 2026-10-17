import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const { logTaskMemory, startMemorySampler } = await import('./memory-diagnostics')

const usage = (rssMb: number) => ({
  rss: rssMb * 1024 * 1024,
  heapUsed: 100 * 1024 * 1024,
  heapTotal: 150 * 1024 * 1024,
  external: 10 * 1024 * 1024,
  arrayBuffers: 5 * 1024 * 1024,
}) as NodeJS.MemoryUsage

let log: MockInstance<typeof console.log>

beforeEach(() => {
  vi.useFakeTimers()
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const lines = () => log.mock.calls.map(([line]) => String(line))

describe('logTaskMemory', () => {
  it('logs rss, heap parts and the running tasks around a task', () => {
    vi.spyOn(process, 'memoryUsage').mockReturnValue(usage(512))

    logTaskMemory('reprocess', 'start')
    logTaskMemory('external-enrichment', 'start')
    logTaskMemory('reprocess', 'end')

    expect(lines()).toEqual([
      '[memory] task=reprocess start rss=512MB heapUsed=100MB heapTotal=150MB external=10MB arrayBuffers=5MB running=reprocess',
      '[memory] task=external-enrichment start rss=512MB heapUsed=100MB heapTotal=150MB external=10MB arrayBuffers=5MB running=external-enrichment,reprocess',
      '[memory] task=reprocess end rss=512MB heapUsed=100MB heapTotal=150MB external=10MB arrayBuffers=5MB running=external-enrichment',
    ])
    logTaskMemory('external-enrichment', 'end')
  })

  it('stays silent when switched off', () => {
    vi.stubEnv('ZVG_MEMORY_LOG', '0')
    logTaskMemory('enrich', 'start')
    logTaskMemory('enrich', 'end')
    expect(log).not.toHaveBeenCalled()
  })
})

describe('startMemorySampler', () => {
  it('logs only on a noticeable rss change and as a slow heartbeat', () => {
    const memory = vi.spyOn(process, 'memoryUsage').mockReturnValue(usage(500))
    const timer = startMemorySampler()
    expect(lines()).toHaveLength(1)
    expect(lines()[0]).toContain('boot rss=500MB')

    memory.mockReturnValue(usage(520))
    vi.advanceTimersByTime(60_000)
    expect(lines()).toHaveLength(1)

    memory.mockReturnValue(usage(900))
    vi.advanceTimersByTime(60_000)
    expect(lines()).toHaveLength(2)
    expect(lines()[1]).toContain('sample rss=900MB')

    vi.advanceTimersByTime(10 * 60_000)
    expect(lines().at(-1)).toContain('heartbeat rss=900MB')

    clearInterval(timer!)
  })

  it('does not start when switched off', () => {
    vi.stubEnv('ZVG_MEMORY_LOG', '0')
    expect(startMemorySampler()).toBeNull()
    expect(log).not.toHaveBeenCalled()
  })
})
