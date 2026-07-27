// Generic key/value settings store (app_settings table) — admin-configurable
// values that take effect without a redeploy. The first user was the
// per-use-case LLM max-output-tokens limit (see
// docs/plans/2026-07-23-llm-max-output-tokens-config.md). Table is reusable
// for future settings; readers should still fall back gracefully when a key
// is absent, since a fresh install has no rows yet.

import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { supportsLlmProviderExecutionMode } from './llm-provider-capabilities'

export type LlmMaxTokensKind = 'extraction' | 'summary' | 'translation'
export type LlmProviderScope = 'extraction' | 'translation'

export const DEFAULT_ENABLED_COUNTRIES = ['de', 'se'] as const
const ENABLED_COUNTRIES_KEY = 'enabled_countries'

function coerceEnabledCountries(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_ENABLED_COUNTRIES]
  return [
    ...new Set(
      value
        .filter((code): code is string => typeof code === 'string')
        .map((code) => code.trim().toLowerCase())
        .filter((code) => /^[a-z]{2}$/.test(code)),
    ),
  ]
}

export async function getEnabledCountries(db: Pool): Promise<string[]> {
  const { rows } = await db.query<{ value: unknown }>(
    'SELECT value FROM app_settings WHERE key = $1',
    [ENABLED_COUNTRIES_KEY],
  )
  return rows[0] ? coerceEnabledCountries(rows[0].value) : [...DEFAULT_ENABLED_COUNTRIES]
}

export async function setEnabledCountries(db: Pool, countries: readonly string[]): Promise<void> {
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [ENABLED_COUNTRIES_KEY, JSON.stringify(coerceEnabledCountries([...countries]))],
  )
}

const KINDS: LlmMaxTokensKind[] = ['extraction', 'summary', 'translation']

// Exactly today's hard-coded values (the provider fallbacks in
// claude-proxy.ts/openai-compatible.ts/gemini-native.ts, and the
// resolveLlmConfig() overrides in summary.post.ts/translation.post.ts) — a
// fresh install with no app_settings row is not a behavior change.
export const DEFAULT_LLM_MAX_TOKENS: Record<LlmMaxTokensKind, number> = {
  extraction: 4096,
  summary: 1024,
  translation: 8192,
}

// Guards against a fat-fingered dashboard value silencing every LLM call
// (too low) or blowing up cost (too high) — not a meaningful real-world
// bound otherwise.
const MIN_MAX_TOKENS = 256
const MAX_MAX_TOKENS = 32_768

function keyFor(kind: LlmMaxTokensKind): string {
  return `llm_max_tokens_${kind}`
}

function clamp(value: number): number {
  return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.round(value)))
}

function coerce(value: unknown, kind: LlmMaxTokensKind): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value) : DEFAULT_LLM_MAX_TOKENS[kind]
}

export async function getLlmMaxTokens(db: Pool, kind: LlmMaxTokensKind): Promise<number> {
  const { rows } = await db.query<{ value: unknown }>(
    'SELECT value FROM app_settings WHERE key = $1',
    [keyFor(kind)],
  )
  return coerce(rows[0]?.value, kind)
}

export async function getAllLlmMaxTokens(db: Pool): Promise<Record<LlmMaxTokensKind, number>> {
  const { rows } = await db.query<{ key: string; value: unknown }>(
    'SELECT key, value FROM app_settings WHERE key = ANY($1)',
    [KINDS.map(keyFor)],
  )
  const byKey = new Map(rows.map((r) => [r.key, r.value]))
  const result = {} as Record<LlmMaxTokensKind, number>
  for (const kind of KINDS) result[kind] = coerce(byKey.get(keyFor(kind)), kind)
  return result
}

export async function setLlmMaxTokens(db: Pool, kind: LlmMaxTokensKind, value: number): Promise<void> {
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [keyFor(kind), JSON.stringify(clamp(value))],
  )
}

// DB-backed override for server/utils/extract/llm.ts's provider switch — lets
// /settings flip the active extraction provider (e.g. gemini-native ->
// claude-proxy while no Gemini budget is set up) without a redeploy. Absent
// row = keep using the ENV-configured provider (nuxt.config.ts's
// extractLlm.*), same graceful-degrade contract as the max-tokens settings
// above.
export type LlmProvider = 'claude-proxy' | 'openai-compatible' | 'gemini-native'
export type LlmExecutionMode = 'sync' | 'batch'

export const LLM_PROVIDERS: LlmProvider[] = ['claude-proxy', 'openai-compatible', 'gemini-native']
export const LLM_EXECUTION_MODES: LlmExecutionMode[] = ['sync', 'batch']
export const DEFAULT_LLM_EXECUTION_MODE: LlmExecutionMode = 'sync'

export interface LlmProviderOverride {
  provider: LlmProvider
  baseUrl: string
  model: string
  executionMode: LlmExecutionMode
  /** '' when the provider doesn't need one (OAuth-based claude-proxy sidecar);
   *  for api_key-backed claude-proxy resolvers this is the proxy auth token.
   *  Stored as plaintext JSON in app_settings — accepted
   *  tradeoff for this solo-admin deployment (no other DB readers); revisit
   *  with at-rest encryption if that ever changes. */
  apiKey: string
}

export interface LlmProviderProfile extends LlmProviderOverride {
  id: string
  name: string
}

export interface LlmProviderProfileInput {
  id?: string
  name?: string
  provider: LlmProvider
  baseUrl: string
  model: string
  executionMode?: LlmExecutionMode
  /** undefined preserves an existing key for the same profile id; '' clears it. */
  apiKey?: string
}

export type LlmProviderAssignments = Partial<Record<LlmProviderScope, string>>

const LLM_PROVIDER_OVERRIDE_KEY = 'llm_provider_override'
const LLM_TRANSLATION_PROVIDER_OVERRIDE_KEY = 'llm_translation_provider_override'
const LLM_PROVIDER_PROFILES_KEY = 'llm_provider_profiles'
const LLM_PROVIDER_ASSIGNMENTS_KEY = 'llm_provider_assignments'

function providerOverrideKey(scope: LlmProviderScope): string {
  return scope === 'translation' ? LLM_TRANSLATION_PROVIDER_OVERRIDE_KEY : LLM_PROVIDER_OVERRIDE_KEY
}

function coerceProviderOverride(value: unknown): LlmProviderOverride | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.provider !== 'string' || !LLM_PROVIDERS.includes(v.provider as LlmProvider)) return null
  if (typeof v.baseUrl !== 'string' || !v.baseUrl) return null
  if (typeof v.model !== 'string' || !v.model) return null
  if (typeof v.executionMode !== 'string' || !LLM_EXECUTION_MODES.includes(v.executionMode as LlmExecutionMode)) {
    return null
  }
  const override = {
    provider: v.provider as LlmProvider,
    baseUrl: v.baseUrl,
    model: v.model,
    executionMode: v.executionMode as LlmExecutionMode,
    apiKey: typeof v.apiKey === 'string' ? v.apiKey : '',
  }
  return supportsLlmProviderExecutionMode(override.provider, override.executionMode, override.apiKey, override.baseUrl)
    ? override
    : null
}

function isValidProfileId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}$/.test(id)
}

function coerceProviderProfile(value: unknown): LlmProviderProfile | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || !isValidProfileId(v.id)) return null
  const override = coerceProviderOverride(v)
  if (!override) return null
  return {
    ...override,
    id: v.id,
    name: typeof v.name === 'string' && v.name.trim() ? v.name.trim().slice(0, 80) : override.provider,
  }
}

function coerceProviderProfiles(value: unknown): LlmProviderProfile[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const profiles: LlmProviderProfile[] = []
  for (const raw of value) {
    const profile = coerceProviderProfile(raw)
    if (!profile || seen.has(profile.id)) continue
    seen.add(profile.id)
    profiles.push(profile)
  }
  return profiles
}

function coerceAssignments(value: unknown, profileIds: ReadonlySet<string>): LlmProviderAssignments {
  if (!value || typeof value !== 'object') return {}
  const v = value as Record<string, unknown>
  const assignments: LlmProviderAssignments = {}
  for (const scope of ['extraction', 'translation'] as const) {
    if (typeof v[scope] === 'string' && profileIds.has(v[scope])) assignments[scope] = v[scope]
  }
  return assignments
}

export async function getLlmProviderProfiles(db: Pool): Promise<LlmProviderProfile[]> {
  const { rows } = await db.query<{ value: unknown }>(
    'SELECT value FROM app_settings WHERE key = $1',
    [LLM_PROVIDER_PROFILES_KEY],
  )
  return coerceProviderProfiles(rows[0]?.value)
}

export async function getLlmProviderAssignments(db: Pool): Promise<LlmProviderAssignments> {
  const profiles = await getLlmProviderProfiles(db)
  const profileIds = new Set(profiles.map((profile) => profile.id))
  const { rows } = await db.query<{ value: unknown }>(
    'SELECT value FROM app_settings WHERE key = $1',
    [LLM_PROVIDER_ASSIGNMENTS_KEY],
  )
  return coerceAssignments(rows[0]?.value, profileIds)
}

export async function getLlmProviderProfileSettings(db: Pool): Promise<{
  profiles: LlmProviderProfile[]
  assignments: LlmProviderAssignments
}> {
  const profiles = await getLlmProviderProfiles(db)
  const profileIds = new Set(profiles.map((profile) => profile.id))
  const { rows } = await db.query<{ value: unknown }>(
    'SELECT value FROM app_settings WHERE key = $1',
    [LLM_PROVIDER_ASSIGNMENTS_KEY],
  )
  return {
    profiles,
    assignments: coerceAssignments(rows[0]?.value, profileIds),
  }
}

export async function setLlmProviderProfileSettings(
  db: Pool,
  inputProfiles: readonly LlmProviderProfileInput[],
  inputAssignments: LlmProviderAssignments,
): Promise<{ profiles: LlmProviderProfile[]; assignments: LlmProviderAssignments }> {
  const existing = new Map((await getLlmProviderProfiles(db)).map((profile) => [profile.id, profile]))
  const profiles: LlmProviderProfile[] = []
  const seen = new Set<string>()
  for (const input of inputProfiles) {
    const id = input.id && isValidProfileId(input.id) ? input.id : randomUUID()
    if (seen.has(id)) continue
    const current = existing.get(id)
    const executionMode = input.executionMode ?? current?.executionMode ?? DEFAULT_LLM_EXECUTION_MODE
    const apiKey = input.apiKey ?? current?.apiKey ?? ''
    if (!supportsLlmProviderExecutionMode(input.provider, executionMode, apiKey, input.baseUrl)) {
      throw new Error('unsupported provider/executionMode combination')
    }
    profiles.push({
      id,
      name: (input.name?.trim() || current?.name || input.provider).slice(0, 80),
      provider: input.provider,
      baseUrl: input.baseUrl,
      model: input.model,
      executionMode,
      apiKey,
    })
    seen.add(id)
  }
  const profileIds = new Set(profiles.map((profile) => profile.id))
  const assignments = coerceAssignments(inputAssignments, profileIds)
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [LLM_PROVIDER_PROFILES_KEY, JSON.stringify(profiles)],
  )
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [LLM_PROVIDER_ASSIGNMENTS_KEY, JSON.stringify(assignments)],
  )
  return { profiles, assignments }
}

export async function getLlmProviderOverride(
  db: Pool,
  scope: LlmProviderScope = 'extraction',
): Promise<LlmProviderOverride | null> {
  const { profiles, assignments } = await getLlmProviderProfileSettings(db).catch(() => ({
    profiles: [] as LlmProviderProfile[],
    assignments: {} as LlmProviderAssignments,
  }))
  const assigned = assignments[scope]
  const profile = assigned ? profiles.find((candidate) => candidate.id === assigned) : null
  if (profile) {
    return {
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      model: profile.model,
      executionMode: scope === 'translation' ? 'sync' : profile.executionMode,
      apiKey: profile.apiKey,
    }
  }
  const { rows } = await db.query<{ value: unknown }>(
    'SELECT value FROM app_settings WHERE key = $1',
    [providerOverrideKey(scope)],
  )
  return rows[0] ? coerceProviderOverride(rows[0].value) : null
}

// apiKey undefined means "leave the stored key untouched" (the PUT route's
// write-only preserve-on-omit contract). Resolved via COALESCE against the
// current row inside the single upsert statement, not a separate read
// beforehand, so a concurrent rotation/clear/delete can't be clobbered by a
// stale read — the whole read-modify-write happens atomically in Postgres.
export async function setLlmProviderOverride(
  db: Pool,
  value: { provider: LlmProvider; baseUrl: string; model: string; executionMode?: LlmExecutionMode; apiKey?: string },
  scope: LlmProviderScope = 'extraction',
): Promise<LlmProviderOverride> {
  const current = value.executionMode == null || value.apiKey == null
    ? await getLlmProviderOverride(db, scope).catch(() => null)
    : null
  const effectiveExecutionMode = value.executionMode ?? current?.executionMode ?? DEFAULT_LLM_EXECUTION_MODE
  const effectiveApiKey = value.apiKey ?? current?.apiKey ?? ''
  if (!supportsLlmProviderExecutionMode(value.provider, effectiveExecutionMode, effectiveApiKey, value.baseUrl)) {
    throw new Error('unsupported provider/executionMode combination')
  }
  const { rows } = await db.query<{ value: unknown }>(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, jsonb_build_object('provider', $2::text, 'baseUrl', $3::text, 'model', $4::text, 'executionMode', COALESCE($5::text, $7::text), 'apiKey', COALESCE($6::text, '')), now())
     ON CONFLICT (key) DO UPDATE SET
       value = jsonb_build_object(
         'provider', $2::text,
         'baseUrl', $3::text,
         'model', $4::text,
         'executionMode', COALESCE($5::text, app_settings.value->>'executionMode', $7::text),
         'apiKey', COALESCE($6::text, app_settings.value->>'apiKey', '')
       ),
       updated_at = now()
     RETURNING value`,
    [
      providerOverrideKey(scope),
      value.provider,
      value.baseUrl,
      value.model,
      value.executionMode ?? null,
      value.apiKey ?? null,
      DEFAULT_LLM_EXECUTION_MODE,
    ],
  )
  const saved = coerceProviderOverride(rows[0]?.value)
  if (!saved) throw new Error('unsupported provider/executionMode combination')
  return saved
}

export async function readLlmExecutionMode(): Promise<LlmExecutionMode> {
  const { getPool } = await import('./db')
  const db = getPool()
  const override = db ? await getLlmProviderOverride(db).catch(() => null) : null
  return override?.executionMode ?? DEFAULT_LLM_EXECUTION_MODE
}

export async function clearLlmProviderOverride(
  db: Pool,
  scope: LlmProviderScope = 'extraction',
): Promise<void> {
  await db.query('DELETE FROM app_settings WHERE key = $1', [providerOverrideKey(scope)])
}

// DB-backed default for whether the search dashboard hides rules-only
// (regex-parsed, no LLM field ever succeeded) auctions. Defaults to hidden —
// matches the initial rollout decision to only surface complete listings
// until reviewed otherwise from /settings.
const HIDE_RULES_ONLY_KEY = 'hide_rules_only_auctions'
export const DEFAULT_HIDE_RULES_ONLY_AUCTIONS = true

export async function getHideRulesOnlyAuctions(db: Pool): Promise<boolean> {
  const { rows } = await db.query<{ value: unknown }>(
    'SELECT value FROM app_settings WHERE key = $1',
    [HIDE_RULES_ONLY_KEY],
  )
  return typeof rows[0]?.value === 'boolean' ? rows[0].value : DEFAULT_HIDE_RULES_ONLY_AUCTIONS
}

export async function setHideRulesOnlyAuctions(db: Pool, value: boolean): Promise<void> {
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [HIDE_RULES_ONLY_KEY, JSON.stringify(value)],
  )
}
