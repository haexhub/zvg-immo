// Lists configured reusable LLM provider profiles and which profile is assigned
// to each use case. Admin-only via /api/settings/'s settings-auth guard.

import { getPool } from '~/server/utils/db'
import {
  DEFAULT_LLM_CHAIN_STRATEGY,
  getLlmExtractionChainStrategy,
  getLlmProviderOverride,
  getLlmProviderProfileSettings,
  KINDS,
  MAX_PROVIDER_CHAIN_LENGTH,
  type LlmExecutionMode,
  type LlmProvider,
  type LlmProviderAssignments,
  type LlmProviderScope,
} from '~/server/utils/app-settings'
import { llmProviderRequiresApiKey } from '~/server/utils/llm-provider-capabilities'

interface PublicLlmProviderProfile {
  id: string
  name: string
  provider: LlmProvider
  baseUrl: string
  model: string
  executionMode: LlmExecutionMode
  apiKeySet: boolean
  /** True for a profile already stored without the credentials its endpoint
   *  needs. Save-time validation only guards new writes, so without this the
   *  card would keep rendering an unusable profile as if it were fine. */
  apiKeyMissing: boolean
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
    // Trimmed: a stored "   " is as unusable as an empty key, so it must not
    // read as set here or the card would hide the warning below.
    apiKeySet: !!profile.apiKey.trim(),
    apiKeyMissing: !profile.apiKey.trim() && llmProviderRequiresApiKey(profile.provider, profile.baseUrl),
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
  }> = {}
  for (const kind of KINDS) {
    effective[kind] = {
      provider: envConfig?.provider || 'openai-compatible',
      baseUrl: envConfig?.baseUrl || '',
      model: envConfig?.model || '',
      executionMode: 'sync',
    }
  }
  const scopesWithOwnOverride = new Set<LlmProviderScope>()
  if (db) {
    for (const scope of KINDS) {
      const override = await getLlmProviderOverride(db, scope).catch(() => null)
      if (override) {
        scopesWithOwnOverride.add(scope)
        effective[scope] = {
          provider: override.provider,
          baseUrl: override.baseUrl,
          model: override.model,
          executionMode: override.executionMode,
        }
      }
    }
  }
  // An insight without its own chain actually runs on extraction's *resolved*
  // config, not on the env default — insight/[insightId].post.ts falls back to
  // getLlmProviderOverride(db, 'extraction'). Reporting the env default here
  // would make the card claim "uses document extraction's provider" while
  // printing whatever the env happens to hold, which is only what extraction
  // itself falls back to when it has no override either.
  const extractionEffective = effective.extraction
  if (extractionEffective) {
    for (const kind of KINDS) {
      if (kind === 'extraction' || kind === 'translation' || scopesWithOwnOverride.has(kind)) continue
      effective[kind] = { ...extractionEffective }
    }
  }
  return {
    profiles: settings.profiles.map(publicProfile),
    assignments: settings.assignments,
    strategy: db ? await getLlmExtractionChainStrategy(db).catch(() => DEFAULT_LLM_CHAIN_STRATEGY) : DEFAULT_LLM_CHAIN_STRATEGY,
    effective,
    maxChainLength: MAX_PROVIDER_CHAIN_LENGTH,
    scopes: KINDS,
  }
})
