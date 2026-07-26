import {
  fetchAnthropicBatchResults,
  pollAnthropicBatch,
  submitAnthropicBatch,
} from './anthropic-batch'
import {
  fetchGeminiBatchResults,
  isLlmBatchPending,
  pollGeminiBatch,
  submitGeminiBatch,
  type PollResult,
} from './gemini-batch'
import type { ClampedExtraction, LlmConfig, LlmInput } from './llm'

export { isLlmBatchPending }

export function supportsLlmBatch(config: LlmConfig | null | undefined): boolean {
  if (!config) return false
  if (config.provider === 'gemini-native') return true
  // The Claude proxy can batch only when zvg-immo authenticates to a proxy
  // resolver that returns an Anthropic api_key credential. Keeping this gated
  // on config.apiKey avoids silently breaking the OAuth/claude-CLI path.
  return config.provider === 'claude-proxy' && !!config.apiKey
}

export function supportsNativeBatchDocuments(config: LlmConfig | null | undefined): boolean {
  return config?.provider === 'gemini-native' || supportsLlmBatch(config)
}

export async function submitLlmBatch(
  items: { key: string; input: LlmInput }[],
  config: LlmConfig,
  source: 'enrich' | 'reprocess',
): Promise<string | null> {
  if (config.provider === 'gemini-native') return submitGeminiBatch(items, config, source)
  if (config.provider === 'claude-proxy') return submitAnthropicBatch(items, config, source)
  return null
}

export async function pollLlmBatch(jobName: string, config: LlmConfig): Promise<PollResult> {
  return jobName.startsWith('msgbatch_')
    ? pollAnthropicBatch(jobName, config)
    : pollGeminiBatch(jobName, config)
}

export async function fetchLlmBatchResults(
  jobName: string,
  resultFileName: string | undefined,
  config: LlmConfig,
  customIdMap: Record<string, string>,
): Promise<{ key: string; extraction: ClampedExtraction | null }[]> {
  if (jobName.startsWith('msgbatch_')) return fetchAnthropicBatchResults(jobName, config, customIdMap)
  if (!resultFileName) return []
  return fetchGeminiBatchResults(resultFileName, config)
}
