// Updates the LLM provider override (admin-only via /api/settings/'s
// settings-auth guard). apiKey is write-only: omitted in the body leaves the
// stored key unchanged, an explicit '' clears it — the GET route never
// echoes the real value back, so the form can't "round-trip" a stale key.

import { getPool } from '~/server/utils/db'
import {
  LLM_EXECUTION_MODES,
  LLM_PROVIDERS,
  getLlmProviderOverride,
  setLlmProviderOverride,
  type LlmExecutionMode,
  type LlmProvider,
} from '~/server/utils/app-settings'
import { supportsLlmProviderExecutionMode } from '~/server/utils/llm-provider-capabilities'

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
  const incomingExecutionMode =
    typeof body.executionMode === 'string' && LLM_EXECUTION_MODES.includes(body.executionMode as LlmExecutionMode)
      ? (body.executionMode as LlmExecutionMode)
      : undefined
  const provider = body.provider as LlmProvider
  const incomingApiKey = typeof body.apiKey === 'string' ? body.apiKey : undefined
  const current =
    incomingExecutionMode === undefined || incomingApiKey === undefined
      ? await getLlmProviderOverride(db).catch(() => null)
      : null
  const effectiveExecutionMode = incomingExecutionMode ?? current?.executionMode ?? 'sync'
  const effectiveApiKey = incomingApiKey ?? current?.apiKey ?? ''
  if (!supportsLlmProviderExecutionMode(provider, effectiveExecutionMode, effectiveApiKey, body.baseUrl.trim())) {
    throw createError({
      statusCode: 400,
      statusMessage: 'batch: Dieser Provider unterstützt keinen Batch-Modus.',
    })
  }

  const saved = await setLlmProviderOverride(db, {
    provider,
    baseUrl: body.baseUrl.trim(),
    model: body.model.trim(),
    executionMode: incomingExecutionMode,
    apiKey: incomingApiKey,
  })

  return {
    provider: saved.provider,
    baseUrl: saved.baseUrl,
    model: saved.model,
    executionMode: saved.executionMode,
    apiKeySet: !!saved.apiKey,
  }
})
