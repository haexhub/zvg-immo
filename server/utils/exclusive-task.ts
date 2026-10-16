interface ActiveTask {
  controller: AbortController
  promise: Promise<unknown>
  generation: number
}

const activeTasks = new Map<string, ActiveTask>()
const generations = new Map<string, number>()
// Scheduled and boot-time runs come through Nitro's runTask, not HTTP, so the
// request hook in server/plugins/db-bootstrap.ts that holds requests until
// migrations finish never sees them. That plugin registers its migration
// promise here instead, and every run waits on it before touching the DB.
let migrationsReady: Promise<unknown> = Promise.resolve()

export function holdTasksUntilMigrated(migrations: Promise<unknown>): void {
  migrationsReady = migrations
}

export class TaskSupersededError extends Error {
  constructor(task: string) {
    super(`${task} wurde durch einen neueren Lauf beendet`)
    this.name = 'TaskSupersededError'
  }
}

/**
 * Exactly one active run per task name. A newer invocation aborts the active
 * run, waits for its cooperative cleanup, and only then starts. Intermediate
 * queued invocations are discarded so a burst of clicks runs only the latest.
 *
 * With `queue`, a newer invocation instead waits for the active run to finish
 * without aborting it and is never discarded: for tasks whose aborted run
 * loses expensive, unrecoverable work (enrich's hours-long crawl plus its
 * finalize phase) and whose invocations each carry their own scope.
 */
export async function runExclusiveTask<T>(
  task: string,
  operation: (signal: AbortSignal) => Promise<T>,
  options: { queue?: boolean } = {},
): Promise<T> {
  const generation = (generations.get(task) ?? 0) + 1
  generations.set(task, generation)

  const previous = activeTasks.get(task)
  if (!options.queue) previous?.controller.abort(new TaskSupersededError(task))

  const controller = new AbortController()
  let promise!: Promise<T>
  promise = (async () => {
    await previous?.promise.catch(() => undefined)
    try {
      await migrationsReady
    } catch (err) {
      throw new Error(`${task} übersprungen: Datenbank-Migration fehlgeschlagen`, { cause: err })
    }
    if (!options.queue && generations.get(task) !== generation) throw new TaskSupersededError(task)
    const result = await operation(controller.signal)
    // An operation can observe the abort and still return normally (or ignore
    // the signal entirely). Re-check here so a superseded run never reports
    // success for work a newer run has already taken over.
    throwIfTaskAborted(controller.signal)
    return result
  })()

  activeTasks.set(task, { controller, promise, generation })
  try {
    return await promise
  } finally {
    if (activeTasks.get(task)?.promise === promise) activeTasks.delete(task)
  }
}

/**
 * Whether a run of `task` is in flight. Scheduled/boot triggers check this
 * right before runExclusiveTask (no await in between) so they skip instead of
 * superseding a manual run: a manual run started via a direct task entry point
 * is invisible to Nitro's own same-name dedupe.
 */
export function isTaskActive(task: string): boolean {
  return activeTasks.has(task)
}

export function throwIfTaskAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new Error('Task abgebrochen')
}
