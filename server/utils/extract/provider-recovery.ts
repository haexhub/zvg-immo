import type { LlmConfig } from './llm'

// Providers that are restarted from outside (the claude-proxy container under
// `podman auto-update`) drop every in-flight request at once. Those requests
// can't be re-sent safely (see isConnectionDroppedError), but the run doesn't
// have to die with them: this waits until the provider answers again so the
// remaining candidates can proceed. Concurrent lanes share one probe.
const DEFAULT_TIMEOUT_MS = 90_000
const DEFAULT_INTERVAL_MS = 3_000

const probes = new Map<string, Promise<boolean>>()

/** Returns whether the provider's health endpoint answered successfully. */
async function isUp(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/healthz`, { signal: AbortSignal.timeout(3_000) })
    return res.ok
  } catch {
    return false
  }
}

/** Resolves true once the provider is healthy again, false if it stays down
 *  for `timeoutMs` — or immediately false for a provider that has no health
 *  endpoint to poll (only claude-proxy does). */
export function waitForProviderRecovery(
  config: LlmConfig | null,
  { timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = DEFAULT_INTERVAL_MS }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  if (config?.provider !== 'claude-proxy' || !config.baseUrl) return Promise.resolve(false)
  const existing = probes.get(config.baseUrl)
  if (existing) return existing
  const probe = (async () => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
      if (await isUp(config.baseUrl)) return true
    }
    return false
  })().finally(() => probes.delete(config.baseUrl))
  probes.set(config.baseUrl, probe)
  return probe
}
