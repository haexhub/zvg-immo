interface ActiveTask {
  controller: AbortController
  promise: Promise<unknown>
  generation: number
}

const activeTasks = new Map<string, ActiveTask>()
const generations = new Map<string, number>()

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
 */
export async function runExclusiveTask<T>(
  task: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const generation = (generations.get(task) ?? 0) + 1
  generations.set(task, generation)

  const previous = activeTasks.get(task)
  previous?.controller.abort(new TaskSupersededError(task))

  const controller = new AbortController()
  let promise!: Promise<T>
  promise = (async () => {
    await previous?.promise.catch(() => undefined)
    if (generations.get(task) !== generation) throw new TaskSupersededError(task)
    return await operation(controller.signal)
  })()

  activeTasks.set(task, { controller, promise, generation })
  try {
    return await promise
  } finally {
    if (activeTasks.get(task)?.promise === promise) activeTasks.delete(task)
  }
}

export function throwIfTaskAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new Error('Task abgebrochen')
}
