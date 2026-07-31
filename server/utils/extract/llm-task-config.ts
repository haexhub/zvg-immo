import { MAX_LLM_FAILURES } from '~/lib/llm-limits'
import { getPool } from '../db'
import { DEFAULT_LLM_MAX_TOKENS, getLlmMaxTokens, getLlmProviderOverride, getLlmProviderOverrideChain } from '../app-settings'
import { resolveLlmConfig, type LlmConfig } from './llm'

export { MAX_LLM_FAILURES }

export async function readExtractionLlmConfig(): Promise<LlmConfig | null> {
  const c = useRuntimeConfig().extractLlm as
    | { provider?: string; baseUrl?: string; apiKey?: string; model?: string }
    | undefined
  const db = getPool()
  const maxTokens = db
    ? await getLlmMaxTokens(db, 'extraction').catch(() => DEFAULT_LLM_MAX_TOKENS.extraction)
    : DEFAULT_LLM_MAX_TOKENS.extraction
  const override = db ? await getLlmProviderOverride(db, 'extraction').catch(() => null) : null
  return resolveLlmConfig(override ?? c, { maxTokens })
}

/** Same resolution as readExtractionLlmConfig, but the full assigned
 *  fallback chain — every profile assigned to the 'extraction' use case, in
 *  order. Empty when nothing is configured at all (no DB, no override, no
 *  ENV default); a single non-chain override/ENV default surfaces as a
 *  one-element array, same as before. */
export async function readExtractionLlmConfigChain(): Promise<LlmConfig[]> {
  const c = useRuntimeConfig().extractLlm as
    | { provider?: string; baseUrl?: string; apiKey?: string; model?: string }
    | undefined
  const db = getPool()
  const maxTokens = db
    ? await getLlmMaxTokens(db, 'extraction').catch(() => DEFAULT_LLM_MAX_TOKENS.extraction)
    : DEFAULT_LLM_MAX_TOKENS.extraction
  const chain = db ? await getLlmProviderOverrideChain(db, 'extraction').catch(() => []) : []
  const sources = chain.length > 0 ? chain : c ? [c] : []
  return sources
    .map((source) => resolveLlmConfig(source, { maxTokens }))
    .filter((config): config is LlmConfig => config != null)
}
