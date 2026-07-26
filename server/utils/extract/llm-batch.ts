import {
  fetchAnthropicBatchResults,
  pollAnthropicBatch,
  submitAnthropicBatch,
} from './anthropic-batch'
import {
  fetchGeminiBatchResults,
  pollGeminiBatch,
  submitGeminiBatch,
  type PollResult,
} from './gemini-batch'
import {
  fetchOpenAiBatchResults,
  pollOpenAiBatch,
  submitOpenAiBatch,
} from './openai-batch'
import type { ClampedExtraction, LlmConfig, LlmInput } from './llm'
import { isOpenAiBatchBaseUrl } from '../llm-provider-capabilities'

// A submitted-but-not-yet-polled item is marked with `llmBatchJob` (see
// AuctionExtraction.llmBatchJob) so enrich.ts/reprocess.ts don't re-submit it
// to a second job while the first is still in flight — job submission isn't
// idempotent. Batch jobs expire after 48h if never completed, so a marker
// older than that is orphaned and the item becomes eligible again rather than
// stuck forever.
const LLM_BATCH_JOB_EXPIRY_MS = 48 * 60 * 60 * 1000

export function isLlmBatchPending(
  entry: { llmBatchJob?: string; at: string } | undefined,
  now: number = Date.now(),
): boolean {
  if (!entry?.llmBatchJob) return false
  const at = Date.parse(entry.at)
  return Number.isFinite(at) && now - at < LLM_BATCH_JOB_EXPIRY_MS
}

export interface LlmBatchSubmitResult {
  jobName: string
  submitted: Array<{ key: string; jobName: string }>
  retryItems: Array<{ key: string; input: LlmInput }>
}

export function supportsLlmBatch(config: LlmConfig | null | undefined): boolean {
  if (!config) return false
  if (config.provider === 'gemini-native') return true
  if (config.provider === 'openai-compatible') return !!config.apiKey && isOpenAiBatchBaseUrl(config.baseUrl)
  // The Claude proxy can batch only when zvg-immo authenticates to a proxy
  // resolver that returns an Anthropic api_key credential. Keeping this gated
  // on config.apiKey avoids silently breaking the OAuth/claude-CLI path.
  return config.provider === 'claude-proxy' && !!config.apiKey
}

export function supportsNativeBatchDocuments(config: LlmConfig | null | undefined): boolean {
  return config?.provider === 'gemini-native' || (config?.provider === 'claude-proxy' && supportsLlmBatch(config))
}

export async function submitLlmBatch(
  items: { key: string; input: LlmInput }[],
  config: LlmConfig,
  source: 'enrich' | 'reprocess',
): Promise<LlmBatchSubmitResult | null> {
  if (config.provider === 'gemini-native') {
    const jobName = await submitGeminiBatch(items, config, source)
    return jobName
      ? { jobName, submitted: items.map((item) => ({ key: item.key, jobName })), retryItems: [] }
      : null
  }
  if (config.provider === 'claude-proxy') return submitAnthropicBatch(items, config, source)
  if (config.provider === 'openai-compatible') return submitOpenAiBatch(items, config, source)
  return null
}

export async function pollLlmBatch(jobName: string, config: LlmConfig): Promise<PollResult> {
  if (jobName.startsWith('msgbatch_')) return pollAnthropicBatch(jobName, config)
  if (jobName.startsWith('batch_')) return pollOpenAiBatch(jobName, config)
  return pollGeminiBatch(jobName, config)
}

export async function fetchLlmBatchResults(
  jobName: string,
  resultFileName: string | undefined,
  config: LlmConfig,
  customIdMap: Record<string, string>,
): Promise<{ key: string; extraction: ClampedExtraction | null }[]> {
  if (jobName.startsWith('msgbatch_')) return fetchAnthropicBatchResults(jobName, config, customIdMap)
  if (jobName.startsWith('batch_')) {
    if (!resultFileName) return []
    return fetchOpenAiBatchResults(resultFileName, config, customIdMap)
  }
  if (!resultFileName) return []
  return fetchGeminiBatchResults(resultFileName, config)
}
