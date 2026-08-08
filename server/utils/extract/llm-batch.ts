import {
  fetchAnthropicBatchResults,
  pollAnthropicBatch,
  submitAnthropicBatch,
} from './anthropic-batch'
import {
  fetchGeminiBatchResults,
  isGeminiBatchTierPaid,
  pollGeminiBatch,
  submitGeminiBatch,
  type PollResult,
} from './gemini-batch'
import {
  fetchOpenAiBatchResults,
  pollOpenAiBatch,
  submitOpenAiBatch,
} from './openai-batch'
import {
  fetchOpenRouterBatchResults,
  pollOpenRouterBatch,
  submitOpenRouterBatch,
} from './openrouter-batch'
import type { ClampedExtraction, LlmConfig, LlmInput } from './llm'
import { isOpenAiBatchBaseUrl } from '../llm-provider-capabilities'
import { getLlmBatchCapability } from '../llm-batch-jobs'

// A submitted-but-not-yet-polled item is marked with `llmBatchJob` in
// auction_fetch_state so enrich.ts/reprocess.ts don't re-submit it
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
  // Google rejects batchGenerateContent outright on a free-tier key (see
  // gemini-batch.ts's header) — reporting batch support here regardless of
  // tier left enrich.ts stuck forever submitting doomed jobs instead of
  // falling back to the synchronous path.
  if (config.provider === 'gemini-native') return isGeminiBatchTierPaid()
  if (config.provider === 'openai-compatible') return !!config.apiKey && isOpenAiBatchBaseUrl(config.baseUrl)
  if (config.provider === 'openrouter') return !!config.apiKey
  // The Claude proxy can batch only when zvg-immo authenticates to a proxy
  // resolver that returns an Anthropic api_key credential. Keeping this gated
  // on config.apiKey avoids silently breaking the OAuth/claude-CLI path.
  return config.provider === 'claude-proxy' && !!config.apiKey
}

export function supportsNativeBatchDocuments(config: LlmConfig | null | undefined): boolean {
  return config?.provider === 'gemini-native' || (config?.provider === 'claude-proxy' && supportsLlmBatch(config))
}

/** Whether this provider's Batch API accepts non-text content (images/PDF
 *  bytes) in a request. Explicit allowlist rather than excluding just
 *  OpenRouter, so a future provider defaults to "no" (routed to the
 *  synchronous path) until it's actually verified to handle multimodal batch
 *  requests, instead of silently inheriting "yes" by not being OpenRouter —
 *  same conservative-default posture as supportsNativeBatchDocuments above.
 *  OpenRouter's beta Batch API is the one confirmed exception: it rejects
 *  any request carrying image/audio/video/file content outright (see
 *  openrouter-batch.ts) — reprocess.ts checks this before routing a
 *  candidate into the batch queue, so a photo-bearing auction takes the
 *  synchronous path instead of being resubmitted to (and silently skipped
 *  by) the same doomed batch every run forever, since a skipped item is
 *  never marked submitted and so stays eligible for that batch path again
 *  next time. */
export function batchSupportsMultimodal(config: LlmConfig | null | undefined): boolean {
  return config?.provider === 'gemini-native' ||
    config?.provider === 'claude-proxy' ||
    config?.provider === 'openai-compatible'
}

// supportsLlmBatch above only checks static config shape (provider/apiKey/
// baseUrl) — it can't know that e.g. Gemini's free tier rejects every
// batchGenerateContent call with 400 FAILED_PRECONDITION (see
// gemini-batch.ts's header). Each provider's submit function records the
// outcome of its last *real* attempt via recordLlmBatchCapability
// (../llm-batch-jobs.ts); this reads it back so enrich.ts/reprocess.ts can
// fall back to the synchronous path automatically once a provider is
// confirmed broken, instead of submitting doomed jobs run after run.
export async function isLlmBatchProviderBroken(config: LlmConfig | null | undefined): Promise<boolean> {
  if (!config?.provider) return false
  const capability = await getLlmBatchCapability(config.provider)
  return capability?.ok === false
}

export async function submitLlmBatch(
  items: { key: string; input: LlmInput }[],
  config: LlmConfig,
  source: 'enrich' | 'reprocess',
): Promise<LlmBatchSubmitResult | null> {
  if (config.provider === 'gemini-native') {
    return submitGeminiBatch(items, config, source)
  }
  if (config.provider === 'claude-proxy') return submitAnthropicBatch(items, config, source)
  if (config.provider === 'openai-compatible') return submitOpenAiBatch(items, config, source)
  if (config.provider === 'openrouter') return submitOpenRouterBatch(items, config, source)
  return null
}

export async function pollLlmBatch(jobName: string, config: LlmConfig): Promise<PollResult> {
  // Checked first: OpenRouter's own batch ids come back as "batch_<id>" —
  // the exact prefix OpenAI's real ids use (see openrouter-batch.ts) — so our
  // "openrouter_"-wrapped jobName must be matched before the "batch_" branch.
  if (jobName.startsWith('openrouter_')) return pollOpenRouterBatch(jobName, config)
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
  if (jobName.startsWith('openrouter_')) return fetchOpenRouterBatchResults(jobName, config, customIdMap)
  if (jobName.startsWith('msgbatch_')) return fetchAnthropicBatchResults(jobName, config, customIdMap)
  if (jobName.startsWith('batch_')) {
    if (!resultFileName) return []
    return fetchOpenAiBatchResults(resultFileName, config, customIdMap)
  }
  if (!resultFileName) return []
  return fetchGeminiBatchResults(resultFileName, config, customIdMap)
}
