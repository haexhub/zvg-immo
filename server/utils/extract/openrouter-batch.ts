// OpenRouter Batch API client for extraction — see
// https://openrouter.ai/docs/batch-quickstart. Unlike the other three
// providers (OpenAI/Gemini upload a JSONL file; Anthropic posts requests
// inline but streams results from a separate /results endpoint), OpenRouter
// takes the whole request list inline in one POST and returns results inline
// in the *same* GET used for polling, so fetchOpenRouterBatchResults below
// just re-issues that GET rather than following a file/result pointer.
//
// Two OpenRouter-specific wrinkles this file works around:
// - Confirmed live 2026-08-08: job ids come back as "batch_<id>" — the exact
//   same prefix OpenAI's real batch ids use. llm-batch.ts's pollLlmBatch/
//   fetchLlmBatchResults pick the provider purely from the jobName string
//   (see that file's header), so a raw OpenRouter id would collide with the
//   OpenAI branch. Wrapped with an `openrouter_` prefix before it's ever
//   returned/stored; stripped again before calling OpenRouter.
// - The Batch API rejects any request carrying image/audio/video/file
//   content outright (text-only) — buildBatchRequest below skips those items
//   into retryItems, same "don't submit, let the caller retry" contract an
//   empty-parts item gets on every other provider. llm-batch.ts also exports
//   batchSupportsMultimodal() so reprocess.ts can route a photo-bearing
//   candidate straight to the synchronous path instead of resubmitting it to
//   (and having it skipped by) this batch path every run forever.
//
// *** UNVERIFIED as of 2026-08-08: this is OpenRouter's beta Batch API. No
// job has ever actually completed against it — max request count/payload
// size, rate limits and webhook support aren't documented anywhere. Treat
// the request/response shapes here as best-effort until confirmed against a
// real completed job. ***

import {
  buildParts,
  clampExtraction,
  SYSTEM_PROMPT,
  UNIVERSAL_AUCTION_SCHEMA,
  UNIVERSAL_AUCTION_SCHEMA_NAME,
  type LlmConfig,
  type LlmInput,
} from './llm'
import { parseOpenAiExtractionResponse, parseOpenAiUsage, toOpenAiContent, toOpenRouterSchema } from './providers/openai-compatible'
import { apiBase, customIdForKey, extractBatchItemErrorMessage, extractOfetchErrorMessage, isTransientBatchError } from './batch-shared'
import { insertLlmBatchJob, recordLlmBatchCapability } from '../llm-batch-jobs'
import type { PollResult } from './gemini-batch'
import type { LlmBatchResultItem, LlmBatchSubmitResult } from './llm-batch'

const JOB_NAME_PREFIX = 'openrouter_'

/** OpenRouter's Batch API lives under a different top-level path than the
 *  chat-completions root profiles are configured with — confirmed live: POST
 *  .../api/v1/batches 404s, POST .../api/beta/batches 401s (route exists, no
 *  key). Derived from the configured baseUrl rather than hardcoded so a
 *  profile pointed at a mirror/proxy of OpenRouter still resolves. */
function betaApiBase(config: LlmConfig): string {
  const base = apiBase(config)
  return base.endsWith('/v1') ? `${base.slice(0, -3)}/beta` : `${base}/beta`
}

function authHeaders(config: LlmConfig): Record<string, string> {
  return config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}
}

/** Null for an empty input (nothing to send) or one carrying image/document
 *  content — OpenRouter's Batch API rejects the latter outright (see module
 *  header), so those items are left for the caller to route elsewhere. */
function buildBatchRequest(customId: string, input: LlmInput, config: LlmConfig): Record<string, unknown> | null {
  const parts = buildParts(input)
  if (parts.length === 0 || parts.some((part) => part.type !== 'text')) return null
  return {
    custom_id: customId,
    body: {
      max_tokens: config.maxTokens ?? 4096,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: toOpenAiContent(parts) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: UNIVERSAL_AUCTION_SCHEMA_NAME,
          schema: toOpenRouterSchema(UNIVERSAL_AUCTION_SCHEMA),
          strict: true,
        },
      },
      // See openai-compatible.ts's matching opt-in — without it, this item's
      // usage block never carries the billed cost.
      usage: { include: true },
    },
  }
}

export async function submitOpenRouterBatch(
  items: { key: string; input: LlmInput }[],
  config: LlmConfig,
  source: 'enrich' | 'reprocess',
): Promise<LlmBatchSubmitResult | null> {
  if (!config.apiKey) return null

  const requests: Record<string, unknown>[] = []
  const customIdMap: Record<string, string> = {}
  const retryItems: Array<{ key: string; input: LlmInput }> = []
  for (const [index, item] of items.entries()) {
    const customId = customIdForKey(item.key, index)
    const request = buildBatchRequest(customId, item.input, config)
    if (!request) {
      retryItems.push(item)
      continue
    }
    requests.push(request)
    customIdMap[customId] = item.key
  }
  if (requests.length === 0) return null

  try {
    const batch = await $fetch<{ id?: string }>(`${betaApiBase(config)}/batches`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(config),
      },
      body: {
        endpoint: '/v1/chat/completions',
        model: config.model,
        requests,
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!batch.id) {
      const message = 'create response had no batch id'
      console.warn(`[openrouter-batch] ${message}`)
      await recordLlmBatchCapability('openrouter', { ok: false, message, source })
      return null
    }
    // OpenRouter accepted the request — batch submission itself works for
    // this account/model, independent of whether our own bookkeeping below does.
    await recordLlmBatchCapability('openrouter', { ok: true, message: null, source })
    const jobName = `${JOB_NAME_PREFIX}${batch.id}`
    const recorded = await insertLlmBatchJob({
      jobName,
      source,
      itemCount: requests.length,
      customIdMap,
      provider: 'openrouter',
      model: config.model,
      profileId: config.profileId,
    })
    if (!recorded) {
      console.warn(`[openrouter-batch] failed to record job ${jobName} — treating submission as failed`)
      return null
    }
    return {
      jobName,
      submitted: Object.values(customIdMap).map((key) => ({ key, jobName })),
      retryItems,
    }
  } catch (err) {
    const message = extractOfetchErrorMessage(err)
    console.warn(`[openrouter-batch] submit failed: ${message}`)
    if (!isTransientBatchError(err)) {
      await recordLlmBatchCapability('openrouter', { ok: false, message, source })
    }
    return null
  }
}

export async function pollOpenRouterBatch(jobName: string, config: LlmConfig): Promise<PollResult> {
  const id = jobName.slice(JOB_NAME_PREFIX.length)
  try {
    const resp = await $fetch<{ status?: string; error?: { message?: string } | null }>(
      `${betaApiBase(config)}/batches/${id}`,
      {
        headers: authHeaders(config),
        signal: AbortSignal.timeout(30_000),
      },
    )
    if (resp.status === 'completed') return { state: 'succeeded' }
    if (resp.status === 'failed' || resp.status === 'cancelled') return { state: 'failed', errorMessage: resp.error?.message }
    if (resp.status === 'expired') return { state: 'expired', errorMessage: resp.error?.message }
    return { state: 'pending' }
  } catch (err) {
    console.warn(`[openrouter-batch] poll failed for ${jobName}: ${(err as Error).message}`)
    return { state: 'pending' }
  }
}

/** Results are embedded inline on the batch object once it's completed — no
 *  separate result file/endpoint — so this just re-fetches the same resource
 *  pollOpenRouterBatch checked the status of. */
export async function fetchOpenRouterBatchResults(
  jobName: string,
  config: LlmConfig,
  customIdMap: Record<string, string>,
): Promise<LlmBatchResultItem[]> {
  const id = jobName.slice(JOB_NAME_PREFIX.length)
  try {
    const resp = await $fetch<{
      results?: Array<{
        custom_id?: unknown
        response?: { status_code?: unknown; body?: unknown } | null
        error?: unknown
      }> | null
    }>(`${betaApiBase(config)}/batches/${id}`, {
      headers: authHeaders(config),
      signal: AbortSignal.timeout(30_000),
    })
    const out: LlmBatchResultItem[] = []
    for (const result of resp.results ?? []) {
      if (typeof result.custom_id !== 'string') continue
      const key = customIdMap[result.custom_id] ?? result.custom_id
      const ok = !result.error && result.response?.status_code === 200
      const raw = ok ? parseOpenAiExtractionResponse(result.response!.body) : null
      const usage = ok ? parseOpenAiUsage(result.response!.body) : null
      const extraction = raw ? clampExtraction(raw) : null
      out.push({
        key,
        extraction,
        usage,
        error: extraction ? null : (extractBatchItemErrorMessage(result.error, result.response) ?? 'Keine gültige Extraktion in der Batch-Antwort'),
      })
    }
    return out
  } catch (err) {
    console.warn(`[openrouter-batch] fetch results failed for ${jobName}: ${(err as Error).message}`)
    return []
  }
}
