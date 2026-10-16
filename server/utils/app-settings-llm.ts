import type { Pool } from 'pg'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { appSettings } from '../db/schema'
import { llmProviderRequiresApiKey, supportsLlmProviderExecutionMode } from './llm-provider-capabilities'
import { KINDS, readSetting, upsertSetting, type LlmMaxTokensKind } from './app-settings-store'

export type LlmProviderScope = 'extraction' | 'translation' | string
export type LlmProvider = 'claude-proxy' | 'openai-compatible' | 'gemini-native' | 'openrouter'
export type LlmExecutionMode = 'sync' | 'batch'
export const LLM_PROVIDERS: LlmProvider[] = ['claude-proxy', 'openai-compatible', 'gemini-native', 'openrouter']
export const LLM_EXECUTION_MODES: LlmExecutionMode[] = ['sync', 'batch']
export const DEFAULT_LLM_EXECUTION_MODE: LlmExecutionMode = 'sync'

export interface LlmProviderOverride {
  provider: LlmProvider
  baseUrl: string
  model: string
  executionMode: LlmExecutionMode
  apiKey: string
  profileId?: string
}

export interface LlmProviderProfile extends LlmProviderOverride { id: string; name: string }
export interface LlmProviderProfileInput {
  id?: string
  name?: string
  provider: LlmProvider
  baseUrl: string
  model: string
  executionMode?: LlmExecutionMode
  apiKey?: string
}
export type LlmProviderAssignments = Partial<Record<LlmProviderScope, string[]>>
export const LLM_CHAIN_STRATEGIES = ['fallback', 'round-robin'] as const
export type LlmChainStrategy = (typeof LLM_CHAIN_STRATEGIES)[number]
export const DEFAULT_LLM_CHAIN_STRATEGY: LlmChainStrategy = 'fallback'

const LLM_PROVIDER_OVERRIDE_KEY = 'llm_provider_override'
const LLM_TRANSLATION_PROVIDER_OVERRIDE_KEY = 'llm_translation_provider_override'
const LLM_PROVIDER_PROFILES_KEY = 'llm_provider_profiles'
const LLM_PROVIDER_ASSIGNMENTS_KEY = 'llm_provider_assignments'
const LLM_EXTRACTION_CHAIN_STRATEGY_KEY = 'llm_extraction_chain_strategy'

function providerOverrideKey(scope: LlmProviderScope): string {
  if (scope === 'translation') return LLM_TRANSLATION_PROVIDER_OVERRIDE_KEY
  if (scope === 'extraction') return LLM_PROVIDER_OVERRIDE_KEY
  return `llm_provider_override:${scope}`
}

function coerceProviderOverride(value: unknown): LlmProviderOverride | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.provider !== 'string' || !LLM_PROVIDERS.includes(v.provider as LlmProvider)) return null
  if (typeof v.baseUrl !== 'string' || !v.baseUrl || typeof v.model !== 'string' || !v.model) return null
  if (typeof v.executionMode !== 'string' || !LLM_EXECUTION_MODES.includes(v.executionMode as LlmExecutionMode)) return null
  const override = { provider: v.provider as LlmProvider, baseUrl: v.baseUrl, model: v.model,
    executionMode: v.executionMode as LlmExecutionMode, apiKey: typeof v.apiKey === 'string' ? v.apiKey : '' }
  return supportsLlmProviderExecutionMode(override.provider, override.executionMode, override.apiKey, override.baseUrl) ? override : null
}

const isValidProfileId = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id)
function coerceProviderProfile(value: unknown): LlmProviderProfile | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || !isValidProfileId(v.id)) return null
  const override = coerceProviderOverride(v)
  return override ? { ...override, id: v.id, name: typeof v.name === 'string' && v.name.trim() ? v.name.trim().slice(0, 80) : override.provider } : null
}
function coerceProviderProfiles(value: unknown): LlmProviderProfile[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap((raw) => {
    const profile = coerceProviderProfile(raw)
    if (!profile || seen.has(profile.id)) return []
    seen.add(profile.id)
    return [profile]
  })
}

export const MAX_PROVIDER_CHAIN_LENGTH = 5
function coerceAssignments(value: unknown, profileIds: ReadonlySet<string>): LlmProviderAssignments {
  if (!value || typeof value !== 'object') return {}
  const assignments: LlmProviderAssignments = {}
  for (const scope of KINDS) {
    const raw = (value as Record<string, unknown>)[scope]
    const ids = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : []
    const chain = [...new Set(ids.filter((id): id is string => typeof id === 'string' && profileIds.has(id)))].slice(0, MAX_PROVIDER_CHAIN_LENGTH)
    if (chain.length) assignments[scope] = chain
  }
  return assignments
}

export async function getLlmProviderProfiles(db: Pool): Promise<LlmProviderProfile[]> {
  const row = await readSetting(db, LLM_PROVIDER_PROFILES_KEY)
  return coerceProviderProfiles(row?.value)
}
export async function getLlmProviderAssignments(db: Pool): Promise<LlmProviderAssignments> {
  return (await getLlmProviderProfileSettings(db)).assignments
}
export async function getLlmProviderProfileSettings(db: Pool): Promise<{ profiles: LlmProviderProfile[]; assignments: LlmProviderAssignments }> {
  const profiles = await getLlmProviderProfiles(db)
  const row = await readSetting(db, LLM_PROVIDER_ASSIGNMENTS_KEY)
  return { profiles, assignments: coerceAssignments(row?.value, new Set(profiles.map((profile) => profile.id))) }
}

export async function setLlmProviderProfileSettings(db: Pool, inputProfiles: readonly LlmProviderProfileInput[], inputAssignments: LlmProviderAssignments) {
  const existing = new Map((await getLlmProviderProfiles(db)).map((profile) => [profile.id, profile]))
  const profiles: LlmProviderProfile[] = []
  const seen = new Set<string>()
  for (const input of inputProfiles) {
    if (!input.id || !isValidProfileId(input.id)) throw new Error('profile id: ungültiger Wert.')
    if (seen.has(input.id)) throw new Error('profile id: doppelter Wert.')
    const current = existing.get(input.id)
    const executionMode = input.executionMode ?? current?.executionMode ?? DEFAULT_LLM_EXECUTION_MODE
    const apiKey = input.apiKey ?? current?.apiKey ?? ''
    if (!apiKey.trim() && llmProviderRequiresApiKey(input.provider, input.baseUrl)) throw new Error('apiKey: für diesen Provider erforderlich.')
    if (!supportsLlmProviderExecutionMode(input.provider, executionMode, apiKey, input.baseUrl)) throw new Error('unsupported provider/executionMode combination')
    profiles.push({ id: input.id, name: (input.name?.trim() || current?.name || input.provider).slice(0, 80),
      provider: input.provider, baseUrl: input.baseUrl, model: input.model, executionMode, apiKey })
    seen.add(input.id)
  }
  const assignments = coerceAssignments(inputAssignments, new Set(profiles.map((profile) => profile.id)))
  await drizzle(db).transaction(async (tx) => {
    await upsertSetting(tx, LLM_PROVIDER_PROFILES_KEY, profiles)
    await upsertSetting(tx, LLM_PROVIDER_ASSIGNMENTS_KEY, assignments)
  })
  return { profiles, assignments }
}

export async function setLlmProviderProfiles(db: Pool, inputProfiles: readonly LlmProviderProfileInput[]) {
  const { assignments } = await getLlmProviderProfileSettings(db)
  return (await setLlmProviderProfileSettings(db, inputProfiles, assignments)).profiles
}
export async function getLlmExtractionChainStrategy(db: Pool): Promise<LlmChainStrategy> {
  const value = (await readSetting(db, LLM_EXTRACTION_CHAIN_STRATEGY_KEY))?.value
  return LLM_CHAIN_STRATEGIES.includes(value as LlmChainStrategy) ? value as LlmChainStrategy : DEFAULT_LLM_CHAIN_STRATEGY
}
export async function setLlmProviderAssignments(db: Pool, inputAssignments: LlmProviderAssignments, strategy?: unknown) {
  const assignments = coerceAssignments(inputAssignments, new Set((await getLlmProviderProfiles(db)).map((profile) => profile.id)))
  const nextStrategy = LLM_CHAIN_STRATEGIES.includes(strategy as LlmChainStrategy) ? strategy as LlmChainStrategy : null
  await drizzle(db).transaction(async (tx) => {
    await upsertSetting(tx, LLM_PROVIDER_ASSIGNMENTS_KEY, assignments)
    if (nextStrategy) await upsertSetting(tx, LLM_EXTRACTION_CHAIN_STRATEGY_KEY, nextStrategy)
  })
  return { assignments, strategy: nextStrategy ?? await getLlmExtractionChainStrategy(db) }
}
export async function deleteLlmProviderProfile(db: Pool, id: string) {
  const { profiles, assignments } = await getLlmProviderProfileSettings(db)
  const prunedAssignments: LlmProviderAssignments = { ...assignments }
  for (const scope of Object.keys(assignments)) {
    const chain = prunedAssignments[scope]?.filter((assignedId) => assignedId !== id)
    if (chain?.length) prunedAssignments[scope] = chain
    else delete prunedAssignments[scope]
  }
  return setLlmProviderProfileSettings(db, profiles.filter((profile) => profile.id !== id), prunedAssignments)
}

async function resolveAssignedProfileChain(db: Pool, scope: LlmProviderScope): Promise<LlmProviderOverride[]> {
  const { profiles, assignments } = await getLlmProviderProfileSettings(db).catch(() => ({ profiles: [] as LlmProviderProfile[], assignments: {} as LlmProviderAssignments }))
  const byId = new Map(profiles.map((profile) => [profile.id, profile]))
  return (assignments[scope] ?? []).map((id) => byId.get(id)).filter((profile): profile is LlmProviderProfile => !!profile)
    .map((profile) => ({ provider: profile.provider, baseUrl: profile.baseUrl, model: profile.model,
      executionMode: scope === 'translation' ? 'sync' : profile.executionMode, apiKey: profile.apiKey, profileId: profile.id }))
}
export async function getLlmProviderOverride(db: Pool, scope: LlmProviderScope = 'extraction'): Promise<LlmProviderOverride | null> {
  const [primary] = await resolveAssignedProfileChain(db, scope)
  if (primary) return primary
  const row = await readSetting(db, providerOverrideKey(scope))
  return row ? coerceProviderOverride(row.value) : null
}
export async function getLlmProviderOverrideChain(db: Pool, scope: LlmProviderScope = 'extraction'): Promise<LlmProviderOverride[]> {
  const chain = await resolveAssignedProfileChain(db, scope)
  if (chain.length) return chain
  const single = await getLlmProviderOverride(db, scope)
  return single ? [single] : []
}
export async function setLlmProviderOverride(db: Pool, value: { provider: LlmProvider; baseUrl: string; model: string; executionMode?: LlmExecutionMode; apiKey?: string }, scope: LlmProviderScope = 'extraction'): Promise<LlmProviderOverride> {
  const current = value.executionMode == null || value.apiKey == null ? await getLlmProviderOverride(db, scope).catch(() => null) : null
  const effectiveExecutionMode = value.executionMode ?? current?.executionMode ?? DEFAULT_LLM_EXECUTION_MODE
  const effectiveApiKey = value.apiKey ?? current?.apiKey ?? ''
  if (!supportsLlmProviderExecutionMode(value.provider, effectiveExecutionMode, effectiveApiKey, value.baseUrl)) throw new Error('unsupported provider/executionMode combination')
  const key = providerOverrideKey(scope)
  const result = await drizzle(db).execute<{ value: unknown }>(sql`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (${key}, jsonb_build_object('provider', ${value.provider}::text, 'baseUrl', ${value.baseUrl}::text, 'model', ${value.model}::text, 'executionMode', COALESCE(${value.executionMode ?? null}::text, ${DEFAULT_LLM_EXECUTION_MODE}::text), 'apiKey', COALESCE(${value.apiKey ?? null}::text, '')), now())
    ON CONFLICT (key) DO UPDATE SET value = jsonb_build_object('provider', ${value.provider}::text, 'baseUrl', ${value.baseUrl}::text, 'model', ${value.model}::text, 'executionMode', COALESCE(${value.executionMode ?? null}::text, app_settings.value->>'executionMode', ${DEFAULT_LLM_EXECUTION_MODE}::text), 'apiKey', COALESCE(${value.apiKey ?? null}::text, app_settings.value->>'apiKey', '')), updated_at = now()
    RETURNING value
  `)
  const saved = coerceProviderOverride(result.rows[0]?.value)
  if (!saved) throw new Error('unsupported provider/executionMode combination')
  return saved
}
export async function readLlmExecutionMode(): Promise<LlmExecutionMode> {
  const { getPool } = await import('./db')
  const db = getPool()
  return (db ? await getLlmProviderOverride(db).catch(() => null) : null)?.executionMode ?? DEFAULT_LLM_EXECUTION_MODE
}
export async function clearLlmProviderOverride(db: Pool, scope: LlmProviderScope = 'extraction'): Promise<void> {
  await drizzle(db).delete(appSettings).where(eq(appSettings.key, providerOverrideKey(scope)))
}
