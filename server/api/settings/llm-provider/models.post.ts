// Populates the /settings "Modell"-Select with the actually valid/available
// models for the selected provider, instead of a free-text field the admin
// could typo. Each provider's model space comes from a different source:
// - claude-proxy: haex-claude-proxy's own /v1/models (no auth — see
//   server/utils/claude-proxy.ts, which uses PROXY_SETUP_TOKEN only for the
//   /setup/* config endpoints, not /v1/*).
// - gemini-native: Google's ListModels endpoint, which needs an API key.
//   Model availability genuinely varies by key (see providers/gemini-native.ts
//   DEFAULT_MODEL comment — 'gemini-2.5-flash' 404s for newly created keys),
//   so this is queried live rather than hard-coded.
// - openrouter: OpenRouter's own /models catalog (public, no auth needed).
// - openai-compatible: arbitrary self-hosted/third-party endpoints with no
//   common discovery contract — the UI keeps a free-text input for it and
//   never calls this route.

import { getPool } from '~/server/utils/db'
import { getLlmProviderOverride, getLlmProviderProfiles, type LlmProviderScope } from '~/server/utils/app-settings'

export interface LlmModelOption {
  id: string
  label: string
}

async function fetchClaudeProxyModels(baseUrl: string): Promise<LlmModelOption[]> {
  const res = await $fetch<{ data: { id: string; display_name?: string }[] }>(
    `${baseUrl.replace(/\/$/, '')}/v1/models`,
    { signal: AbortSignal.timeout(10_000) },
  )
  return (res.data ?? []).map((m) => ({ id: m.id, label: m.display_name || m.id }))
}

// Extraction sends `response_format: { type: 'json_schema', strict: true }`
// (see providers/openai-compatible.ts), so only models whose endpoint
// actually supports structured_outputs are offered here.
export async function fetchOpenRouterModels(baseUrl: string): Promise<LlmModelOption[]> {
  const res = await $fetch<{ data: { id: string; name?: string }[] }>(
    `${baseUrl.replace(/\/$/, '')}/models`,
    { query: { supported_parameters: 'structured_outputs' }, signal: AbortSignal.timeout(10_000) },
  )
  return (res.data ?? []).map((m) => ({ id: m.id, label: m.name || m.id }))
}

async function fetchGeminiModels(apiKey: string): Promise<LlmModelOption[]> {
  const options: LlmModelOption[] = []
  let pageToken: string | undefined
  do {
    const res = await $fetch<{
      models: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[]
      nextPageToken?: string
    }>('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': apiKey },
      query: { pageSize: 1000, pageToken },
      signal: AbortSignal.timeout(10_000),
    })
    options.push(
      ...(res.models ?? [])
        .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
        .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name })),
    )
    pageToken = res.nextPageToken
  } while (pageToken)
  return options
}

export default defineEventHandler(async (event) => {
  const body = (await readBody<{
    provider?: string
    baseUrl?: string
    apiKey?: string
    scope?: LlmProviderScope
    profileId?: string
  }>(event)) ?? {}
  const provider = String(body.provider ?? '')
  const baseUrl = String(body.baseUrl ?? '')
  const typedApiKey = typeof body.apiKey === 'string' ? body.apiKey : ''
  const scope = body.scope === 'translation' ? 'translation' : 'extraction'
  const profileId = typeof body.profileId === 'string' ? body.profileId : ''

  if (provider === 'claude-proxy') {
    if (!baseUrl) throw createError({ statusCode: 400, statusMessage: 'baseUrl fehlt.' })
    try {
      return { models: await fetchClaudeProxyModels(baseUrl) }
    } catch {
      throw createError({ statusCode: 502, statusMessage: 'Proxy nicht erreichbar, Modelle konnten nicht geladen werden.' })
    }
  }

  if (provider === 'openrouter') {
    if (!baseUrl) throw createError({ statusCode: 400, statusMessage: 'baseUrl fehlt.' })
    try {
      return { models: await fetchOpenRouterModels(baseUrl) }
    } catch {
      throw createError({ statusCode: 502, statusMessage: 'OpenRouter nicht erreichbar, Modelle konnten nicht geladen werden.' })
    }
  }

  if (provider === 'gemini-native') {
    let apiKey = typedApiKey
    if (!apiKey) {
      const db = getPool()
      const profile = db && profileId
        ? (await getLlmProviderProfiles(db)).find((candidate) => candidate.id === profileId)
        : null
      const override = db ? await getLlmProviderOverride(db, scope) : null
      const extractionOverride = scope === 'translation' && db ? await getLlmProviderOverride(db, 'extraction') : null
      if (profile?.provider === 'gemini-native') apiKey = profile.apiKey
      else if (override?.provider === 'gemini-native') apiKey = override.apiKey
      else if (extractionOverride?.provider === 'gemini-native') apiKey = extractionOverride.apiKey
    }
    if (!apiKey) return { models: [], keyRequired: true }
    try {
      return { models: await fetchGeminiModels(apiKey) }
    } catch {
      throw createError({ statusCode: 502, statusMessage: 'Gemini-API nicht erreichbar, Modelle konnten nicht geladen werden.' })
    }
  }

  throw createError({ statusCode: 400, statusMessage: `Modell-Liste wird für Provider "${provider}" nicht unterstützt.` })
})
