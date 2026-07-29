import type { LlmExecutionMode, LlmProvider } from './app-settings'

export function isOpenAiBatchBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    return (
      url.protocol === 'https:' &&
      url.hostname === 'api.openai.com' &&
      url.pathname.replace(/\/+$/, '') === '/v1'
    )
  } catch {
    return false
  }
}

// A profile saved without credentials fails at request time with a provider
// error that looks nothing like "you forgot the key" — gemini-native sends an
// empty x-goog-api-key and Google answers 403 "unregistered callers", which
// then surfaces only as "no result". Reject it at save time instead. Only
// public endpoints are checked: an internal sidecar (loopback, a private
// range, or a container hostname without a dot, e.g. the claude-proxy
// service) legitimately runs keyless, and requiring a key there would block
// valid deployments from saving their profile list at all.
export function llmProviderRequiresApiKey(provider: LlmProvider, baseUrl: string): boolean {
  if (provider === 'gemini-native') return true
  return isPublicEndpoint(baseUrl)
}

function isPublicEndpoint(baseUrl: string): boolean {
  let hostname: string
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return false
  }
  const host = hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost') return false
  // An IPv6 literal carries no dot, so it has to be classified before the
  // dotless-host exemption below — otherwise a globally routable address would
  // be read as a container name and saved keyless.
  if (host.includes(':')) return !isPrivateIpv6(host)
  if (!host.includes('.')) return false
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false
  return true
}

/** ::1 loopback, :: unspecified, fc00::/7 unique-local, fe80::/10 link-local. */
function isPrivateIpv6(host: string): boolean {
  return host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)
}

export function supportsLlmProviderExecutionMode(
  provider: LlmProvider,
  executionMode: LlmExecutionMode,
  apiKey = '',
  baseUrl = '',
): boolean {
  if (executionMode === 'sync') return true
  if (provider === 'gemini-native') return true
  if (provider === 'claude-proxy') return !!apiKey
  return provider === 'openai-compatible' && !!apiKey && isOpenAiBatchBaseUrl(baseUrl)
}
