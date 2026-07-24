// Current LLM provider override + the ENV-configured fallback for the
// /settings "LLM-Provider" section. Lives under /api/settings/ and therefore
// automatically inherits server/middleware/settings-auth.ts's guard.

import { getPool } from '~/server/utils/db'
import { getLlmProviderOverride } from '~/server/utils/app-settings'

export default defineEventHandler(async () => {
  const envConfig = useRuntimeConfig().extractLlm as
    | { provider?: string; baseUrl?: string; model?: string }
    | undefined
  const db = getPool()
  const override = db ? await getLlmProviderOverride(db) : null
  return {
    override: override
      ? { provider: override.provider, baseUrl: override.baseUrl, model: override.model, apiKeySet: !!override.apiKey }
      : null,
    envDefault: {
      provider: envConfig?.provider || 'openai-compatible',
      baseUrl: envConfig?.baseUrl || '',
      model: envConfig?.model || '',
    },
  }
})
