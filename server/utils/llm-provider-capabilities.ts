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
