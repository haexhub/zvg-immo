// Current LLM provider override + the ENV-configured fallback for the
// /settings "LLM-Provider" section. Lives under /api/settings/ and therefore
// automatically inherits server/middleware/settings-auth.ts's guard.

import type { H3Event } from 'h3'
import { getPool } from '~/server/utils/db'
import { getLlmProviderOverride, type LlmProviderScope } from '~/server/utils/app-settings'

function readScope(event: H3Event): LlmProviderScope {
  return getQuery(event).scope === 'translation' ? 'translation' : 'extraction'
}

export default defineEventHandler(async (event) => {
  const scope = readScope(event)
  const envConfig = useRuntimeConfig().extractLlm as
    | { provider?: string; baseUrl?: string; model?: string }
    | undefined
  const db = getPool()
  const override = db ? await getLlmProviderOverride(db, scope) : null
  const extractionOverride = scope === 'translation' && db ? await getLlmProviderOverride(db, 'extraction') : null
  const envDefault = extractionOverride
    ? {
        provider: extractionOverride.provider,
        baseUrl: extractionOverride.baseUrl,
        model: extractionOverride.model,
        executionMode: extractionOverride.executionMode,
      }
    : {
        provider: envConfig?.provider || 'openai-compatible',
        baseUrl: envConfig?.baseUrl || '',
        model: envConfig?.model || '',
        executionMode: 'sync',
      }
  return {
    override: override
      ? {
          provider: override.provider,
          baseUrl: override.baseUrl,
          model: override.model,
          executionMode: override.executionMode,
          apiKeySet: !!override.apiKey,
        }
      : null,
    envDefault,
  }
})
