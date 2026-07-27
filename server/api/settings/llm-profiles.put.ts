// Saves reusable LLM provider profiles and per-use-case assignments. API keys
// are write-only: omitted preserves an existing key for the same profile id,
// explicit '' clears it.

import { getPool } from '~/server/utils/db'
import {
  LLM_EXECUTION_MODES,
  LLM_PROVIDERS,
  setLlmProviderProfileSettings,
  type LlmExecutionMode,
  type LlmProvider,
  type LlmProviderAssignments,
  type LlmProviderProfileInput,
} from '~/server/utils/app-settings'

function readProfile(raw: unknown): LlmProviderProfileInput {
  if (!raw || typeof raw !== 'object') {
    throw createError({ statusCode: 400, statusMessage: 'profiles: ungültiger Wert.' })
  }
  const v = raw as Record<string, unknown>
  if (typeof v.provider !== 'string' || !LLM_PROVIDERS.includes(v.provider as LlmProvider)) {
    throw createError({ statusCode: 400, statusMessage: 'provider: ungültiger Wert.' })
  }
  if (typeof v.baseUrl !== 'string' || !v.baseUrl.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'baseUrl: darf nicht leer sein.' })
  }
  if (typeof v.model !== 'string' || !v.model.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'model: darf nicht leer sein.' })
  }
  const executionMode =
    typeof v.executionMode === 'string' && LLM_EXECUTION_MODES.includes(v.executionMode as LlmExecutionMode)
      ? (v.executionMode as LlmExecutionMode)
      : undefined
  return {
    id: typeof v.id === 'string' ? v.id : undefined,
    name: typeof v.name === 'string' ? v.name : undefined,
    provider: v.provider as LlmProvider,
    baseUrl: v.baseUrl.trim(),
    model: v.model.trim(),
    executionMode,
    apiKey: typeof v.apiKey === 'string' ? v.apiKey : undefined,
  }
}

export default defineEventHandler(async (event) => {
  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Postgres ist nicht konfiguriert.' })
  }
  const body = await readBody<Record<string, unknown>>(event).catch(() => {
    throw createError({ statusCode: 400, statusMessage: 'Ungültiger Request-Body.' })
  })
  if (!Array.isArray(body?.profiles)) {
    throw createError({ statusCode: 400, statusMessage: 'profiles: Array erforderlich.' })
  }
  const profiles = body.profiles.map(readProfile)
  const assignments = (body.assignments && typeof body.assignments === 'object'
    ? body.assignments
    : {}) as LlmProviderAssignments
  try {
    const saved = await setLlmProviderProfileSettings(db, profiles, assignments)
    return {
      profiles: saved.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        provider: profile.provider,
        baseUrl: profile.baseUrl,
        model: profile.model,
        executionMode: profile.executionMode,
        apiKeySet: !!profile.apiKey,
      })),
      assignments: saved.assignments,
    }
  } catch (err) {
    const message = (err as Error).message
    if (
      message === 'unsupported provider/executionMode combination' ||
      message === 'profile id: ungültiger Wert.' ||
      message === 'profile id: doppelter Wert.'
    ) {
      throw createError({ statusCode: 400, statusMessage: message })
    }
    console.warn(`[settings/llm-profiles] save failed: ${message}`)
    throw createError({
      statusCode: 500,
      statusMessage: 'LLM-Profile konnten nicht gespeichert werden.',
    })
  }
})
