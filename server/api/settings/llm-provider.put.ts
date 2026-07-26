// Updates the LLM provider override (admin-only via /api/settings/'s
// settings-auth guard). apiKey is write-only: omitted in the body leaves the
// stored key unchanged, an explicit '' clears it — the GET route never
// echoes the real value back, so the form can't "round-trip" a stale key.

import { getPool } from '~/server/utils/db'
import {
  DEFAULT_LLM_EXECUTION_MODE,
  LLM_EXECUTION_MODES,
  LLM_PROVIDERS,
  setLlmProviderOverride,
  type LlmExecutionMode,
  type LlmProvider,
} from '~/server/utils/app-settings'

export default defineEventHandler(async (event) => {
  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Postgres ist nicht konfiguriert.' })
  }
  const body = await readBody<Record<string, unknown>>(event).catch(() => ({}) as Record<string, unknown>)

  if (typeof body.provider !== 'string' || !LLM_PROVIDERS.includes(body.provider as LlmProvider)) {
    throw createError({ statusCode: 400, statusMessage: 'provider: ungültiger Wert.' })
  }
  if (typeof body.baseUrl !== 'string' || !body.baseUrl.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'baseUrl: darf nicht leer sein.' })
  }
  if (typeof body.model !== 'string' || !body.model.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'model: darf nicht leer sein.' })
  }
  const executionMode =
    typeof body.executionMode === 'string' && LLM_EXECUTION_MODES.includes(body.executionMode as LlmExecutionMode)
      ? (body.executionMode as LlmExecutionMode)
      : DEFAULT_LLM_EXECUTION_MODE
  if (executionMode === 'batch' && body.provider === 'openai-compatible') {
    throw createError({
      statusCode: 400,
      statusMessage: 'batch: Dieser Provider unterstützt keinen Batch-Modus.',
    })
  }

  const saved = await setLlmProviderOverride(db, {
    provider: body.provider as LlmProvider,
    baseUrl: body.baseUrl.trim(),
    model: body.model.trim(),
    executionMode,
    apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
  })

  return {
    provider: saved.provider,
    baseUrl: saved.baseUrl,
    model: saved.model,
    executionMode: saved.executionMode,
    apiKeySet: !!saved.apiKey,
  }
})
