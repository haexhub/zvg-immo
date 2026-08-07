// Shared interval-polling mechanics for settings cards that trigger a
// detached background task and want their own status to keep refreshing
// without a manual click. Each card owns its own "is this still running?"
// check — a computed, a captured baseline comparison, whatever fits its
// status shape — this composable only owns the timer and the safety cutoff.
export function usePollWhileActive(
  isActive: () => boolean,
  refresh: () => void | Promise<void>,
  options: { intervalMs?: number; maxAttempts?: number } = {},
) {
  const intervalMs = options.intervalMs ?? 3000
  const maxAttempts = options.maxAttempts ?? null
  let timer: ReturnType<typeof setInterval> | null = null
  let attempts = 0

  function stop(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function start(): void {
    if (timer || !isActive()) return
    attempts = 0
    timer = setInterval(async () => {
      await refresh()
      attempts++
      if (!isActive() || (maxAttempts != null && attempts >= maxAttempts)) stop()
    }, intervalMs)
  }

  onBeforeUnmount(stop)

  return { start, stop }
}
