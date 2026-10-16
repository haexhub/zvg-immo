/**
 * Runs `worker` over `items` with up to `concurrency` in flight, handing items
 * out in order. A lane stops pulling once `shouldStop()` is true or any worker
 * has thrown; work already in flight still finishes, then the first error is
 * rethrown. With `concurrency` 1 this is a plain sequential loop.
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  let next = 0
  let failure: { error: unknown } | undefined
  async function lane(): Promise<void> {
    while (!failure && !shouldStop()) {
      const index = next++
      if (index >= items.length) return
      try {
        await worker(items[index] as T)
      } catch (error) {
        failure ??= { error }
      }
    }
  }
  const lanes = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length))
  await Promise.all(Array.from({ length: lanes }, lane))
  if (failure) throw failure.error
}
