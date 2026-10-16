import { afterEach, describe, expect, it, vi } from 'vitest'
import { holdTasksUntilMigrated, isTaskActive, runExclusiveTask, TaskSupersededError, throwIfTaskAborted } from './exclusive-task'

afterEach(() => {
  holdTasksUntilMigrated(Promise.resolve())
})

describe('runExclusiveTask', () => {
  it('aborts the active run and starts its replacement only after cleanup', async () => {
    const events: string[] = []
    let releaseCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })

    const first = runExclusiveTask('refresh-test', async (signal) => {
      events.push('first:start')
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
      events.push('first:cleanup')
      await cleanup
      throwIfTaskAborted(signal)
      return 'first'
    })
    await vi.waitFor(() => expect(events).toContain('first:start'))

    const second = runExclusiveTask('refresh-test', async () => {
      events.push('second:start')
      return 'second'
    })
    await vi.waitFor(() => expect(events).toContain('first:cleanup'))
    expect(events).not.toContain('second:start')

    releaseCleanup()

    await expect(first).rejects.toBeInstanceOf(TaskSupersededError)
    await expect(second).resolves.toBe('second')
    expect(events).toEqual(['first:start', 'first:cleanup', 'second:start'])
  })

  it('discards intermediate queued runs so only the newest replacement starts', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const started: string[] = []

    const first = runExclusiveTask('enrich-test', async (signal) => {
      started.push('first')
      await firstGate
      throwIfTaskAborted(signal)
      return 'first'
    })
    await vi.waitFor(() => expect(started).toEqual(['first']))

    const intermediate = runExclusiveTask('enrich-test', async () => {
      started.push('intermediate')
      return 'intermediate'
    })
    const newest = runExclusiveTask('enrich-test', async () => {
      started.push('newest')
      return 'newest'
    })
    releaseFirst()

    await expect(first).rejects.toBeInstanceOf(TaskSupersededError)
    await expect(intermediate).rejects.toBeInstanceOf(TaskSupersededError)
    await expect(newest).resolves.toBe('newest')
    expect(started).toEqual(['first', 'newest'])
  })

  it('rejects a superseded run that ignored the signal and returned normally', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    // Deliberately never inspects the signal — the wrapper has to catch this.
    const first = runExclusiveTask('ignores-signal-test', async () => {
      await firstGate
      return 'first'
    })
    const second = runExclusiveTask('ignores-signal-test', async () => 'second')
    releaseFirst()

    await expect(first).rejects.toBeInstanceOf(TaskSupersededError)
    await expect(second).resolves.toBe('second')
  })

  it('allows different task names to run independently', async () => {
    const [refresh, enrich] = await Promise.all([
      runExclusiveTask('refresh-independent', async () => 'refresh'),
      runExclusiveTask('enrich-independent', async () => 'enrich'),
    ])

    expect(refresh).toBe('refresh')
    expect(enrich).toBe('enrich')
  })

  it('reports a run as active until it settles, so scheduled triggers can yield to it', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    expect(isTaskActive('active-test')).toBe(false)

    const run = runExclusiveTask('active-test', async () => {
      await gate
      return 'done'
    })
    expect(isTaskActive('active-test')).toBe(true)
    expect(isTaskActive('other-task')).toBe(false)

    release()
    await expect(run).resolves.toBe('done')
    expect(isTaskActive('active-test')).toBe(false)
  })

  it('starts a run only after the registered migrations finished', async () => {
    let finishMigrations!: () => void
    holdTasksUntilMigrated(new Promise<void>((resolve) => {
      finishMigrations = resolve
    }))
    const operation = vi.fn(async () => 'done')

    const run = runExclusiveTask('migration-wait-test', operation)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(operation).not.toHaveBeenCalled()

    finishMigrations()
    await expect(run).resolves.toBe('done')
  })

  it('fails a run without starting it when the migrations failed', async () => {
    const migrationError = new Error('relation missing')
    const migrations = Promise.reject(migrationError)
    migrations.catch(() => undefined)
    holdTasksUntilMigrated(migrations)
    const operation = vi.fn(async () => 'done')

    await expect(runExclusiveTask('migration-failed-test', operation))
      .rejects.toMatchObject({ cause: migrationError })
    expect(operation).not.toHaveBeenCalled()
  })
})
