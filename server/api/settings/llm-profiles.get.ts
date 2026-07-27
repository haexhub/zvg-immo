// Lists configured reusable LLM provider profiles and which profile is assigned
// to each use case. Admin-only via /api/settings/'s settings-auth guard.

import { getPool } from '~/server/utils/db'
import {
  getLlmProviderOverride,
  getLlmProviderProfileSettings,
  type LlmExecutionMode,
  type LlmProvider,
  type LlmProviderAssignments,
  type LlmProviderScope,
} from '~/server/utils/app-settings'

interface PublicLlmProviderProfile {
  id: string
  name: string
  provider: LlmProvider
  baseUrl: string
  model: string
  executionMode: LlmExecutionMode
  apiKeySet: boolean
}

function publicProfile(profile: {
  id: string
  name: string
  provider: LlmProvider
  baseUrl: string
  model: string
  executionMode: LlmExecutionMode
  apiKey: string
}): PublicLlmProviderProfile {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    model: profile.model,
    executionMode: profile.executionMode,
    apiKeySet: !!profile.apiKey,
  }
}

export default defineEventHandler(async () => {
  const envConfig = useRuntimeConfig().extractLlm as
    | { provider?: string; baseUrl?: string; model?: string }
    | undefined
  const db = getPool()
  const settings = db ? await getLlmProviderProfileSettings(db) : { profiles: [], assignments: {} as LlmProviderAssignments }
  const effective: Record<LlmProviderScope, {
    provider: string
    baseUrl: string
    model: string
    executionMode: LlmExecutionMode
  }> = {
    extraction: {
      provider: envConfig?.provider || 'openai-compatible',
      baseUrl: envConfig?.baseUrl || '',
      model: envConfig?.model || '',
      executionMode: 'sync',
    },
    translation: {
      provider: envConfig?.provider || 'openai-compatible',
      baseUrl: envConfig?.baseUrl || '',
      model: envConfig?.model || '',
      executionMode: 'sync',
    },
  }
  if (db) {
    for (const scope of ['extraction', 'translation'] as const) {
      const override = await getLlmProviderOverride(db, scope).catch(() => null)
      if (override) {
        effective[scope] = {
          provider: override.provider,
          baseUrl: override.baseUrl,
          model: override.model,
          executionMode: override.executionMode,
        }
      }
    }
  }
  return {
    profiles: settings.profiles.map(publicProfile),
    assignments: settings.assignments,
    effective,
  }
})
