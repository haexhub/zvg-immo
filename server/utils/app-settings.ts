// Generic key/value settings store (app_settings table) — admin-configurable
// values that take effect without a redeploy. The first user was the
// per-use-case LLM max-output-tokens limit (see
// docs/plans/2026-07-23-llm-max-output-tokens-config.md). Table is reusable
// for future settings; readers should still fall back gracefully when a key
// is absent, since a fresh install has no rows yet.

import type { Pool } from 'pg'
import { eq, inArray, sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { appSettings } from '../db/schema'
import { llmProviderRequiresApiKey, supportsLlmProviderExecutionMode } from './llm-provider-capabilities'
import { INSIGHT_REGISTRY } from './insights/registry'

/** Every export below keeps accepting a raw `pg` `Pool` — callers still get
 *  it from `getPool()` — and wraps it in Drizzle internally per call; the
 *  wrap is cheap (no I/O), so this avoids rippling a `getDb()` signature
 *  change through every one of this module's ~20 call sites. */
async function readSetting(db: Pool, key: string): Promise<{ value: unknown } | undefined> {
  const [row] = await drizzle(db).select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key))
  return row
}

/** The single upsert shape every write below shares — usable with a Drizzle
 *  instance or a transaction handle, so the conflict target and `updated_at`
 *  handling stay in one place. */
function upsertSetting(executor: Pick<NodePgDatabase, 'insert'>, key: string, value: unknown) {
  const updatedAt = new Date()
  return executor.insert(appSettings).values({ key, value, updatedAt })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt } })
}

async function writeSetting(db: Pool, key: string, value: unknown): Promise<void> {
  await upsertSetting(drizzle(db), key, value)
}

// Widened to `string` rather than a closed union of insight ids: insight
// definitions carry a plain `id: string`, so a type-level union built from
// them would collapse to `string` anyway. Kind ids are validated at runtime
// against KINDS below instead (same as every other value this module reads
// from app_settings).
export type LlmMaxTokensKind = 'extraction' | 'translation' | string
// Widened the same way as LlmMaxTokensKind, for the same reason: an insight's
// id is a plain string, so a closed union built from INSIGHT_REGISTRY would
// collapse to `string` anyway. Validated at runtime against KINDS instead —
// see coerceAssignments and providerOverrideKey below, both of which used to
// hardcode ['extraction', 'translation'] and silently drop/collide on
// anything else.
export type LlmProviderScope = 'extraction' | 'translation' | string

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
  const row = await readSetting(db, ENABLED_COUNTRIES_KEY)
  return row ? coerceEnabledCountries(row.value) : [...DEFAULT_ENABLED_COUNTRIES]
}

export async function setEnabledCountries(db: Pool, countries: readonly string[]): Promise<void> {
  await writeSetting(db, ENABLED_COUNTRIES_KEY, coerceEnabledCountries([...countries]))
}

// Single source of truth for valid kinds: the two fixed use-cases plus one
// per registered insight (server/utils/insights/registry.ts) — adding an
// insight registers its settings kind automatically, no second place to edit.
export const KINDS: LlmMaxTokensKind[] = ['extraction', 'translation', ...INSIGHT_REGISTRY.map((d) => d.id)]

// Exactly today's hard-coded values for extraction/translation (the provider
// fallbacks in claude-proxy.ts/openai-compatible.ts/gemini-native.ts, and the
// resolveLlmConfig() overrides in translation.post.ts) plus each insight's own
// declared default — a fresh install with no app_settings row is not a
// behavior change.
export const DEFAULT_LLM_MAX_TOKENS: Record<LlmMaxTokensKind, number> = {
  extraction: 4096,
  translation: 8192,
  ...Object.fromEntries(INSIGHT_REGISTRY.map((d) => [d.id, d.maxTokensDefault])),
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
  if (typeof value === 'number' && Number.isFinite(value)) return clamp(value)
  // DEFAULT_LLM_MAX_TOKENS[kind] is only `undefined` for a kind that isn't
  // registered at all (impossible for any caller going through KINDS) —
  // noUncheckedIndexedAccess just can't prove that from a widened string key.
  return DEFAULT_LLM_MAX_TOKENS[kind] ?? clamp(MIN_MAX_TOKENS)
}

export async function getLlmMaxTokens(db: Pool, kind: LlmMaxTokensKind): Promise<number> {
  const row = await readSetting(db, keyFor(kind))
  return coerce(row?.value, kind)
}

export async function getAllLlmMaxTokens(db: Pool): Promise<Record<LlmMaxTokensKind, number>> {
  const rows = await drizzle(db).select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(inArray(appSettings.key, KINDS.map(keyFor)))
  const byKey = new Map(rows.map((r) => [r.key, r.value]))
  const result = {} as Record<LlmMaxTokensKind, number>
  for (const kind of KINDS) result[kind] = coerce(byKey.get(keyFor(kind)), kind)
  return result
}

export async function setLlmMaxTokens(db: Pool, kind: LlmMaxTokensKind, value: number): Promise<void> {
  await writeSetting(db, keyFor(kind), clamp(value))
}

// DB-backed override for server/utils/extract/llm.ts's provider switch — lets
// /settings flip the active extraction provider (e.g. gemini-native ->
// claude-proxy while no Gemini budget is set up) without a redeploy. Absent
// row = keep using the ENV-configured provider (nuxt.config.ts's
// extractLlm.*), same graceful-degrade contract as the max-tokens settings
// above.
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
  /** '' when the provider doesn't need one (OAuth-based claude-proxy sidecar);
   *  for api_key-backed claude-proxy resolvers this is the proxy auth token.
   *  Stored as plaintext JSON in app_settings — accepted
   *  tradeoff for this solo-admin deployment (no other DB readers); revisit
   *  with at-rest encryption if that ever changes. */
  apiKey: string
  /** Set only when this override was resolved from an assigned
   *  LlmProviderProfile (resolveAssignedProfileChain) — lets reprocess.ts
   *  record which profile actually produced a version (WP-1 provenance). */
  profileId?: string
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

// Ordered profile-id chain per use case: the first entry is primary, the rest
// are automatic fallbacks tried in order when the current one is rate-limited/
// over quota or its model is otherwise unavailable (see getLlmProviderOverrideChain).
export type LlmProviderAssignments = Partial<Record<LlmProviderScope, string[]>>

// How the extraction chain picks which assigned profile serves a given
// auction. 'fallback' is the original behaviour: always start at the primary
// and only walk on when the current link is unavailable — right when the chain
// is a quality ranking (best model first, cheaper stand-in behind it).
// 'round-robin' advances the starting point per auction instead, which is what
// a chain of equivalent profiles backed by *different* API keys wants: each key
// is its own Google project and the free-tier quota is per project per model
// (`GenerateRequestsPerMinutePerProjectPerModel-FreeTier`), so N keys carry N×
// the throughput — unreachable while every request starts at the same primary.
// Only the starting point rotates: an unavailable model still falls through the
// remaining links in order, so resilience is identical in both modes.
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
  // Any other scope (an insight id) gets its own key — falling through to
  // LLM_PROVIDER_OVERRIDE_KEY here would silently alias every insight's
  // single-override row onto extraction's.
  return `llm_provider_override:${scope}`
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

// Guards against an unbounded chain turning one slow/unavailable model into a
// very long request (each link is a full attempt-with-retries elsewhere).
// Exported so the settings UI can enforce the same limit instead of letting a
// user add entries the server would silently truncate on save.
export const MAX_PROVIDER_CHAIN_LENGTH = 5

function coerceAssignments(value: unknown, profileIds: ReadonlySet<string>): LlmProviderAssignments {
  if (!value || typeof value !== 'object') return {}
  const v = value as Record<string, unknown>
  const assignments: LlmProviderAssignments = {}
  for (const scope of KINDS) {
    const raw = v[scope]
    // A bare string is the pre-fallback-chain stored shape — accepted so an
    // existing single assignment keeps resolving without a migration step.
    const ids = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : []
    const chain = [
      ...new Set(ids.filter((id): id is string => typeof id === 'string' && profileIds.has(id))),
    ].slice(0, MAX_PROVIDER_CHAIN_LENGTH)
    if (chain.length > 0) assignments[scope] = chain
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

export async function getLlmProviderProfileSettings(db: Pool): Promise<{
  profiles: LlmProviderProfile[]
  assignments: LlmProviderAssignments
}> {
  const profiles = await getLlmProviderProfiles(db)
  const profileIds = new Set(profiles.map((profile) => profile.id))
  const row = await readSetting(db, LLM_PROVIDER_ASSIGNMENTS_KEY)
  return {
    profiles,
    assignments: coerceAssignments(row?.value, profileIds),
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
    if (!input.id || !isValidProfileId(input.id)) {
      throw new Error('profile id: ungültiger Wert.')
    }
    const id = input.id
    if (seen.has(id)) {
      throw new Error('profile id: doppelter Wert.')
    }
    const current = existing.get(id)
    const executionMode = input.executionMode ?? current?.executionMode ?? DEFAULT_LLM_EXECUTION_MODE
    const apiKey = input.apiKey ?? current?.apiKey ?? ''
    if (!apiKey.trim() && llmProviderRequiresApiKey(input.provider, input.baseUrl)) {
      throw new Error('apiKey: für diesen Provider erforderlich.')
    }
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
  await drizzle(db).transaction(async (tx) => {
    await upsertSetting(tx, LLM_PROVIDER_PROFILES_KEY, profiles)
    await upsertSetting(tx, LLM_PROVIDER_ASSIGNMENTS_KEY, assignments)
  })
  return { profiles, assignments }
}

// Saves the profile list without touching the existing use-case assignments
// — backs the "LLM-Provider" card's own save action, kept independent from
// the "Modellzuordnung" card's setLlmProviderAssignments below so saving one
// card never silently commits unsaved edits from the other.
export async function setLlmProviderProfiles(
  db: Pool,
  inputProfiles: readonly LlmProviderProfileInput[],
): Promise<LlmProviderProfile[]> {
  const { assignments } = await getLlmProviderProfileSettings(db)
  const saved = await setLlmProviderProfileSettings(db, inputProfiles, assignments)
  return saved.profiles
}

export async function getLlmExtractionChainStrategy(db: Pool): Promise<LlmChainStrategy> {
  const row = await readSetting(db, LLM_EXTRACTION_CHAIN_STRATEGY_KEY)
  const value = row?.value
  return LLM_CHAIN_STRATEGIES.includes(value as LlmChainStrategy)
    ? (value as LlmChainStrategy)
    : DEFAULT_LLM_CHAIN_STRATEGY
}

// Saves only the use-case assignments (and, when given, the extraction chain's
// strategy — same card, same save button); profiles are left untouched.
// Invalid or now-deleted profile ids are dropped via coerceAssignments. An
// omitted/unrecognised strategy leaves the stored one as it is, same
// preserve-on-omit contract the apiKey writes use.
export async function setLlmProviderAssignments(
  db: Pool,
  inputAssignments: LlmProviderAssignments,
  strategy?: unknown,
): Promise<{ assignments: LlmProviderAssignments; strategy: LlmChainStrategy }> {
  const profileIds = new Set((await getLlmProviderProfiles(db)).map((profile) => profile.id))
  const assignments = coerceAssignments(inputAssignments, profileIds)
  const nextStrategy = LLM_CHAIN_STRATEGIES.includes(strategy as LlmChainStrategy)
    ? (strategy as LlmChainStrategy)
    : null
  await drizzle(db).transaction(async (tx) => {
    await upsertSetting(tx, LLM_PROVIDER_ASSIGNMENTS_KEY, assignments)
    if (nextStrategy) {
      await upsertSetting(tx, LLM_EXTRACTION_CHAIN_STRATEGY_KEY, nextStrategy)
    }
  })
  return { assignments, strategy: nextStrategy ?? (await getLlmExtractionChainStrategy(db)) }
}

// Deletes a single profile immediately (not gated behind the profile list's
// "Speichern" button) and prunes any assignment pointing to it.
export async function deleteLlmProviderProfile(
  db: Pool,
  id: string,
): Promise<{ profiles: LlmProviderProfile[]; assignments: LlmProviderAssignments }> {
  const { profiles, assignments } = await getLlmProviderProfileSettings(db)
  const remaining = profiles.filter((profile) => profile.id !== id)
  const prunedAssignments: LlmProviderAssignments = { ...assignments }
  for (const scope of Object.keys(assignments)) {
    const chain = prunedAssignments[scope]?.filter((assignedId) => assignedId !== id)
    if (chain && chain.length > 0) prunedAssignments[scope] = chain
    else delete prunedAssignments[scope]
  }
  return setLlmProviderProfileSettings(db, remaining, prunedAssignments)
}

async function resolveAssignedProfileChain(db: Pool, scope: LlmProviderScope): Promise<LlmProviderOverride[]> {
  const { profiles, assignments } = await getLlmProviderProfileSettings(db).catch(() => ({
    profiles: [] as LlmProviderProfile[],
    assignments: {} as LlmProviderAssignments,
  }))
  const byId = new Map(profiles.map((profile) => [profile.id, profile]))
  return (assignments[scope] ?? [])
    .map((id) => byId.get(id))
    .filter((profile): profile is LlmProviderProfile => !!profile)
    .map((profile) => ({
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      model: profile.model,
      executionMode: scope === 'translation' ? 'sync' : profile.executionMode,
      apiKey: profile.apiKey,
      profileId: profile.id,
    }))
}

export async function getLlmProviderOverride(
  db: Pool,
  scope: LlmProviderScope = 'extraction',
): Promise<LlmProviderOverride | null> {
  const [primary] = await resolveAssignedProfileChain(db, scope)
  if (primary) return primary
  const row = await readSetting(db, providerOverrideKey(scope))
  return row ? coerceProviderOverride(row.value) : null
}

// Same resolution as getLlmProviderOverride, but returns every profile
// assigned to `scope` in order instead of just the primary. Callers that want
// automatic fallback across models (rate limit/quota, or a model id that's
// stopped resolving — see gemini-native.ts) iterate this chain instead of
// giving up on the first failure. The pre-profiles single-override row has no
// concept of ordering, so it surfaces as a one-element chain, same as before.
export async function getLlmProviderOverrideChain(
  db: Pool,
  scope: LlmProviderScope = 'extraction',
): Promise<LlmProviderOverride[]> {
  const chain = await resolveAssignedProfileChain(db, scope)
  if (chain.length > 0) return chain
  const single = await getLlmProviderOverride(db, scope)
  return single ? [single] : []
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
  const key = providerOverrideKey(scope)
  const executionMode = value.executionMode ?? null
  const apiKey = value.apiKey ?? null
  const result = await drizzle(db).execute<{ value: unknown }>(sql`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (${key}, jsonb_build_object('provider', ${value.provider}::text, 'baseUrl', ${value.baseUrl}::text, 'model', ${value.model}::text, 'executionMode', COALESCE(${executionMode}::text, ${DEFAULT_LLM_EXECUTION_MODE}::text), 'apiKey', COALESCE(${apiKey}::text, '')), now())
    ON CONFLICT (key) DO UPDATE SET
      value = jsonb_build_object(
        'provider', ${value.provider}::text,
        'baseUrl', ${value.baseUrl}::text,
        'model', ${value.model}::text,
        'executionMode', COALESCE(${executionMode}::text, app_settings.value->>'executionMode', ${DEFAULT_LLM_EXECUTION_MODE}::text),
        'apiKey', COALESCE(${apiKey}::text, app_settings.value->>'apiKey', '')
      ),
      updated_at = now()
    RETURNING value
  `)
  const saved = coerceProviderOverride(result.rows[0]?.value)
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
  await drizzle(db).delete(appSettings).where(eq(appSettings.key, providerOverrideKey(scope)))
}

// DB-backed default for whether the search dashboard hides rules-only
// (regex-parsed, no LLM field ever succeeded) auctions. Defaults to hidden —
// matches the initial rollout decision to only surface complete listings
// until reviewed otherwise from /settings.
const HIDE_RULES_ONLY_KEY = 'hide_rules_only_auctions'
export const DEFAULT_HIDE_RULES_ONLY_AUCTIONS = true

export async function getHideRulesOnlyAuctions(db: Pool): Promise<boolean> {
  const row = await readSetting(db, HIDE_RULES_ONLY_KEY)
  return typeof row?.value === 'boolean' ? row.value : DEFAULT_HIDE_RULES_ONLY_AUCTIONS
}

export async function setHideRulesOnlyAuctions(db: Pool, value: boolean): Promise<void> {
  await writeSetting(db, HIDE_RULES_ONLY_KEY, value)
}

// Admin emergency stop for every LLM call the app makes (extraction,
// translation, insights, batch submission) — a runaway bug must be
// stoppable from /settings without a redeploy. Checked at each use case's
// config-resolution point (readExtractionLlmConfigChain, resolveLlmConfigForProfile,
// resolveActiveLlmConfigChain, the insight endpoint) rather than deep inside
// getProvider(): resolving to "nothing configured" there reuses each
// caller's existing graceful-degrade path instead of counting a request that
// never went out as an llmFailures strike.
const LLM_KILL_SWITCH_KEY = 'llm_kill_switch'
export const DEFAULT_LLM_KILL_SWITCH = false

export async function getLlmKillSwitch(db: Pool): Promise<boolean> {
  const row = await readSetting(db, LLM_KILL_SWITCH_KEY)
  return typeof row?.value === 'boolean' ? row.value : DEFAULT_LLM_KILL_SWITCH
}

export async function setLlmKillSwitch(db: Pool, value: boolean): Promise<void> {
  await writeSetting(db, LLM_KILL_SWITCH_KEY, value)
}
