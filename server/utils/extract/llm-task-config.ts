import { MAX_LLM_FAILURES } from '~/lib/llm-limits'
import { getPool } from '../db'
import { DEFAULT_LLM_MAX_TOKENS, getLlmMaxTokens, getLlmProviderOverride } from '../app-settings'
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
