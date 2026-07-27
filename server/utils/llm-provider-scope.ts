import type { H3Event } from 'h3'
import type { LlmProviderScope } from './app-settings'

export function readLlmProviderScope(event: H3Event): LlmProviderScope {
  return getQuery(event).scope === 'translation' ? 'translation' : 'extraction'
}
