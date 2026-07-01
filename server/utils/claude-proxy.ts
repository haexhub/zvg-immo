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
  const baseUrl = String((config.extractLlm as { baseUrl?: string }).baseUrl ?? '')
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
    const msg = (err as Error).message || 'proxy unreachable'
    throw createError({ statusCode: status, statusMessage: `Claude-Proxy: ${msg}` })
  }
}
