import type { Pool } from 'pg'
import { eq, inArray } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { appSettings } from '../db/schema'
import { INSIGHT_REGISTRY } from './insights/registry'

/** Shared app_settings I/O. All public settings helpers still accept a raw Pool. */
export async function readSetting(db: Pool, key: string): Promise<{ value: unknown } | undefined> {
  const [row] = await drizzle(db).select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key))
  return row
}

export function upsertSetting(executor: Pick<NodePgDatabase, 'insert'>, key: string, value: unknown) {
  const updatedAt = new Date()
  return executor.insert(appSettings).values({ key, value, updatedAt })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt } })
}

export async function writeSetting(db: Pool, key: string, value: unknown): Promise<void> {
  await upsertSetting(drizzle(db), key, value)
}

export type LlmMaxTokensKind = 'extraction' | 'translation' | string

export const DEFAULT_ENABLED_COUNTRIES = ['de', 'se'] as const
const ENABLED_COUNTRIES_KEY = 'enabled_countries'

function coerceEnabledCountries(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_ENABLED_COUNTRIES]
  return [...new Set(value
    .filter((code): code is string => typeof code === 'string')
    .map((code) => code.trim().toLowerCase())
    .filter((code) => /^[a-z]{2}$/.test(code)))]
}

export async function getEnabledCountries(db: Pool): Promise<string[]> {
  const row = await readSetting(db, ENABLED_COUNTRIES_KEY)
  return row ? coerceEnabledCountries(row.value) : [...DEFAULT_ENABLED_COUNTRIES]
}

export async function setEnabledCountries(db: Pool, countries: readonly string[]): Promise<void> {
  await writeSetting(db, ENABLED_COUNTRIES_KEY, coerceEnabledCountries([...countries]))
}

export const KINDS: LlmMaxTokensKind[] = ['extraction', 'translation', ...INSIGHT_REGISTRY.map((d) => d.id)]
export const DEFAULT_LLM_MAX_TOKENS: Record<LlmMaxTokensKind, number> = {
  extraction: 4096,
  translation: 8192,
  ...Object.fromEntries(INSIGHT_REGISTRY.map((d) => [d.id, d.maxTokensDefault])),
}

const MIN_MAX_TOKENS = 256
const MAX_MAX_TOKENS = 32_768
const keyFor = (kind: LlmMaxTokensKind) => `llm_max_tokens_${kind}`
const clamp = (value: number) => Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.round(value)))
const coerce = (value: unknown, kind: LlmMaxTokensKind) => (
  typeof value === 'number' && Number.isFinite(value)
    ? clamp(value)
    : DEFAULT_LLM_MAX_TOKENS[kind] ?? clamp(MIN_MAX_TOKENS)
)

export async function getLlmMaxTokens(db: Pool, kind: LlmMaxTokensKind): Promise<number> {
  const row = await readSetting(db, keyFor(kind))
  return coerce(row?.value, kind)
}

export async function getAllLlmMaxTokens(db: Pool): Promise<Record<LlmMaxTokensKind, number>> {
  const rows = await drizzle(db).select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings).where(inArray(appSettings.key, KINDS.map(keyFor)))
  const byKey = new Map(rows.map((r) => [r.key, r.value]))
  const result = {} as Record<LlmMaxTokensKind, number>
  for (const kind of KINDS) result[kind] = coerce(byKey.get(keyFor(kind)), kind)
  return result
}

export async function setLlmMaxTokens(db: Pool, kind: LlmMaxTokensKind, value: number): Promise<void> {
  await writeSetting(db, keyFor(kind), clamp(value))
}
