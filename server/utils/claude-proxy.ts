// Thin wrapper around the haex-claude-proxy /setup/* endpoints. Every route
// requires `Authorization: Bearer <PROXY_SETUP_TOKEN>` from the same env var
// that's mounted into the proxy container — the token stays server-side only,
// never reaches the browser.
//
// Errors are normalized to createError() so the settings UI sees the same
// shape regardless of whether the proxy is unreachable, misconfigured, or
// returned an application error.

const PROXY_TIMEOUT_MS = 10_000

interface ProxyConfig {
  baseUrl: string
  token: string
}

function readProxyConfig(): ProxyConfig {
  const config = useRuntimeConfig()
  const baseUrl = String(config.claudeProxyUrl ?? '')
  const token = String(config.proxySetupToken ?? '')
  if (!baseUrl) {
    throw createError({
      statusCode: 503,
      statusMessage: 'LLM proxy is not configured on this server.',
    })
  }
  if (!token) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Proxy setup token is not configured on this server.',
    })
  }
  return { baseUrl: baseUrl.replace(/\/$/, ''), token }
}

/**
 * Extract the upstream's own status message without leaking internal details.
 * `$fetch`'s `.message` includes the request URL and node fetch internals
 * (e.g. `[GET] "http://haex-claude-proxy:8080/setup/status": <no response>
 * fetch failed`) — surfacing that to the browser exposes container names and
 * ports. Prefer the proxy's structured `statusMessage` / `data.statusMessage`
 * whenever available, and fall back to a generic message otherwise.
 */
function extractProxyMessage(err: unknown): string {
  const e = err as { statusMessage?: unknown; data?: { statusMessage?: unknown } }
  if (typeof e.data?.statusMessage === 'string' && e.data.statusMessage) return e.data.statusMessage
  if (typeof e.statusMessage === 'string' && e.statusMessage) return e.statusMessage
  return 'Proxy nicht erreichbar.'
}

/** GET or POST against /setup/<path> on the proxy. `body` is JSON-encoded. */
export async function callProxySetup<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const { baseUrl, token } = readProxyConfig()
  try {
    const res = await $fetch(`${baseUrl}/setup${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      body,
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    })
    return res as T
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode ?? 502
    throw createError({
      statusCode: status,
      statusMessage: `Claude-Proxy: ${extractProxyMessage(err)}`,
    })
  }
}
