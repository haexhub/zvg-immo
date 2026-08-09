import type { Pool } from 'pg'
import { LLM_FAILURE_RETRY_COOLDOWN_HOURS, MAX_LLM_FAILURES } from '~/lib/llm-limits'
import { getPool } from '../db'
import {
  DEFAULT_LLM_CHAIN_STRATEGY,
  DEFAULT_LLM_MAX_TOKENS,
  getLlmExtractionChainStrategy,
  getLlmKillSwitch,
  getLlmMaxTokens,
  getLlmProviderOverrideChain,
  getLlmProviderProfiles,
  type LlmChainStrategy,
} from '../app-settings'
import { resolveLlmConfig, type LlmConfig } from './llm'

export { LLM_FAILURE_RETRY_COOLDOWN_HOURS, MAX_LLM_FAILURES }

export async function readExtractionLlmConfig(): Promise<LlmConfig | null> {
  const [primary] = await readExtractionLlmConfigChain()
  return primary ?? null
}

/** The full assigned fallback chain for the 'extraction' use case — every
 *  profile assigned to it, in order. Empty when nothing is configured at all
 *  (no DB, no override, no ENV default); a single non-chain override/ENV
 *  default surfaces as a one-element array, same as before. */
export async function readExtractionLlmConfigChain(): Promise<LlmConfig[]> {
  const db = getPool()
  if (db && (await getLlmKillSwitch(db).catch(() => false))) return []
  const c = useRuntimeConfig().extractLlm as
    | { provider?: string; baseUrl?: string; apiKey?: string; model?: string }
    | undefined
  const maxTokens = db
    ? await getLlmMaxTokens(db, 'extraction').catch(() => DEFAULT_LLM_MAX_TOKENS.extraction)
    : DEFAULT_LLM_MAX_TOKENS.extraction
  const chain = db ? await getLlmProviderOverrideChain(db, 'extraction').catch(() => []) : []
  const sources = chain.length > 0 ? chain : c ? [c] : []
  return sources
    .map((source) => resolveLlmConfig(source, { maxTokens }))
    .filter((config): config is LlmConfig => config != null)
}

/** Resolves one explicitly chosen profile (docs/plans/2026-08-08-admin-
 *  auktions-technikseite.md, WP-4's admin single-run) into a single LlmConfig
 *  — no chain, no fallback, so the measurement is of exactly that model. Null
 *  when the id doesn't match a configured profile. */
export async function resolveLlmConfigForProfile(db: Pool, profileId: string): Promise<LlmConfig | null> {
  if (await getLlmKillSwitch(db).catch(() => false)) return null
  const profiles = await getLlmProviderProfiles(db)
  const profile = profiles.find((candidate) => candidate.id === profileId)
  if (!profile) return null
  const maxTokens = await getLlmMaxTokens(db, 'extraction').catch(() => DEFAULT_LLM_MAX_TOKENS.extraction)
  return resolveLlmConfig(
    { provider: profile.provider, baseUrl: profile.baseUrl, apiKey: profile.apiKey, model: profile.model, profileId: profile.id },
    { maxTokens },
  )
}

/** Whether the extraction chain is a quality ranking ('fallback') or a pool of
 *  equivalent profiles to spread load over ('round-robin') — see
 *  LLM_CHAIN_STRATEGIES. Falls back to the default whenever no DB is
 *  configured, so the task keeps its pre-setting behaviour. */
export async function readExtractionChainStrategy(): Promise<LlmChainStrategy> {
  const db = getPool()
  if (!db) return DEFAULT_LLM_CHAIN_STRATEGY
  return getLlmExtractionChainStrategy(db).catch(() => DEFAULT_LLM_CHAIN_STRATEGY)
}
