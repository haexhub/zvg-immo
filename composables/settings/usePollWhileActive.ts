// Shared interval-polling mechanics for settings cards that trigger a
// detached background task and want their own status to keep refreshing
// without a manual click. Each card owns its own "is this still running?"
// check — a computed, a captured baseline comparison, whatever fits its
// status shape — this composable only owns the timer and the safety cutoff.
// The next tick is scheduled only once the previous refresh settled: a status
// endpoint slower than intervalMs (osm-import.get's count(*) can be) would
// otherwise stack overlapping requests on a fixed interval.
export function usePollWhileActive(
  isActive: () => boolean,
  refresh: () => void | Promise<void>,
  options: { intervalMs?: number; maxAttempts?: number } = {},
) {
  const intervalMs = options.intervalMs ?? 3000
  const maxAttempts = options.maxAttempts ?? null
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let attempts = 0
  // Bumped on every start() so a callback from a stop()+start() cycle that
  // raced past its own cycle's stop() can recognize it's stale and bail out
  // instead of arming a second, untracked timer alongside the new cycle's.
  let generation = 0

  function stop(): void {
    running = false
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  function schedule(cycle: number): void {
    timer = setTimeout(async () => {
      timer = null
      try {
        await refresh()
      } catch {
        // A failed refresh must not silently end polling; the caller's
        // refresh() is responsible for surfacing the error itself.
      }
      // stop() during the awaited refresh (unmount, or a second start()) must
      // not be undone by re-arming the timer below.
      if (!running || cycle !== generation) return
      attempts++
      if (!isActive() || (maxAttempts != null && attempts >= maxAttempts)) stop()
      else schedule(cycle)
    }, intervalMs)
  }

  function start(): void {
    if (running || !isActive()) return
    running = true
    attempts = 0
    generation++
    schedule(generation)
  }

  onBeforeUnmount(stop)

  return { start, stop }
}
