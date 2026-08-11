// Anthropic Message Batches client for extraction. This speaks the same
// Anthropic Messages shape as ClaudeProxyProvider, but submits many requests
// to `/v1/messages/batches` and later consumes the JSONL results stream.

import {
  buildParts,
  clampExtraction,
  parseExtractionResponse,
  SYSTEM_PROMPT,
  UNIVERSAL_AUCTION_SCHEMA,
  type ClampedExtraction,
  type ContentPart,
  type LlmConfig,
  type LlmInput,
} from './llm'
import { apiBase, customIdForKey, extractOfetchErrorMessage, isTransientBatchError } from './batch-shared'
import { insertLlmBatchJob, recordLlmBatchCapability } from '../llm-batch-jobs'
import type { PollResult } from './gemini-batch'
import type { LlmBatchSubmitResult } from './llm-batch'

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } }

const MAX_ANTHROPIC_BATCH_REQUESTS = 100_000
const MAX_ANTHROPIC_BATCH_BODY_BYTES = 256 * 1024 * 1024
const ANTHROPIC_BATCH_BODY_HEADROOM_BYTES = 1024 * 1024

function authHeaders(config: LlmConfig): Record<string, string> {
  return config.apiKey ? { 'x-api-key': config.apiKey } : {}
}

function toAnthropicContent(parts: ContentPart[]): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = []
  for (const part of parts) {
    if (part.type === 'text') blocks.push({ type: 'text', text: part.text })
    else if (part.type === 'image') {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.data } })
    } else if (part.type === 'document') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: part.mimeType, data: part.data } })
    }
  }
  return blocks
}

function buildRequest(customId: string, input: LlmInput, config: LlmConfig): Record<string, unknown> | null {
  const parts = buildParts(input)
  if (parts.length === 0) return null
  return {
    custom_id: customId,
    params: {
      model: config.model,
      max_tokens: config.maxTokens ?? 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: toAnthropicContent(parts) }],
      tools: [
        {
          name: 'final_result',
          description: 'Gib die extrahierten Eckdaten im universellen Auktions-JSON zurück.',
          input_schema: UNIVERSAL_AUCTION_SCHEMA,
        },
      ],
      tool_choice: { type: 'tool', name: 'final_result' },
    },
  }
}

function serializedBatchBytes(requests: readonly Record<string, unknown>[]): number {
  return Buffer.byteLength(JSON.stringify({ requests }), 'utf8')
}

function serializedRequestBytes(request: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(request), 'utf8')
}

async function submitAnthropicRequestChunk(
  requests: Record<string, unknown>[],
  customIdMap: Record<string, string>,
  config: LlmConfig,
  source: 'enrich' | 'reprocess',
): Promise<string | null> {
  const batch = await $fetch<{ id?: string }>(`${apiBase(config)}/v1/messages/batches`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...authHeaders(config),
    },
    body: { requests },
    signal: AbortSignal.timeout(30_000),
  })
  if (!batch.id) {
    const message = 'create response had no batch id'
    console.warn(`[anthropic-batch] ${message}`)
    await recordLlmBatchCapability('claude-proxy', { ok: false, message, source })
    return null
  }
  // Anthropic accepted the request — batch submission itself works for this
  // account/model, independent of whether our own bookkeeping below does.
  await recordLlmBatchCapability('claude-proxy', { ok: true, message: null, source })
  const recorded = await insertLlmBatchJob({
    jobName: batch.id,
    source,
    itemCount: requests.length,
    customIdMap,
  })
  if (!recorded) {
    console.warn(`[anthropic-batch] failed to record job ${batch.id} — treating submission as failed`)
    return null
  }
  return batch.id
}

export async function submitAnthropicBatch(
  items: { key: string; input: LlmInput }[],
  config: LlmConfig,
  source: 'enrich' | 'reprocess',
): Promise<LlmBatchSubmitResult | null> {
  const chunks: Array<{
    requests: Record<string, unknown>[]
    customIdMap: Record<string, string>
    items: Array<{ key: string; input: LlmInput }>
  }> = []
  const skipped: Array<{ key: string; input: LlmInput }> = []
  let currentRequests: Record<string, unknown>[] = []
  let currentCustomIdMap: Record<string, string> = {}
  let currentItems: Array<{ key: string; input: LlmInput }> = []
  let currentBytes = serializedBatchBytes([])
  for (const [index, item] of items.entries()) {
    const customId = customIdForKey(item.key, index)
    const request = buildRequest(customId, item.input, config)
    if (!request) {
      skipped.push(item)
      continue
    }
    const requestBytes = serializedRequestBytes(request)
    const firstRequestBytes = serializedBatchBytes([request])
    if (firstRequestBytes > MAX_ANTHROPIC_BATCH_BODY_BYTES - ANTHROPIC_BATCH_BODY_HEADROOM_BYTES) {
      console.warn(`[anthropic-batch] skipping oversized request for ${item.key}`)
      skipped.push(item)
      continue
    }
    const separatorBytes = currentRequests.length > 0 ? 1 : 0
    if (
      currentRequests.length >= MAX_ANTHROPIC_BATCH_REQUESTS ||
      (
        currentRequests.length > 0 &&
        currentBytes + separatorBytes + requestBytes > MAX_ANTHROPIC_BATCH_BODY_BYTES - ANTHROPIC_BATCH_BODY_HEADROOM_BYTES
      )
    ) {
      chunks.push({ requests: currentRequests, customIdMap: currentCustomIdMap, items: currentItems })
      currentRequests = []
      currentCustomIdMap = {}
      currentItems = []
      currentBytes = serializedBatchBytes([])
    }
    currentBytes += (currentRequests.length > 0 ? 1 : 0) + requestBytes
    currentRequests.push(request)
    currentCustomIdMap[customId] = item.key
    currentItems.push(item)
  }
  if (currentRequests.length > 0) {
    chunks.push({ requests: currentRequests, customIdMap: currentCustomIdMap, items: currentItems })
  }
  if (chunks.length === 0) return null

  const jobNames: string[] = []
  const submitted: LlmBatchSubmitResult['submitted'] = []
  let retryItems = [...skipped]
  for (const [chunkIndex, chunk] of chunks.entries()) {
    try {
      const jobName = await submitAnthropicRequestChunk(chunk.requests, chunk.customIdMap, config, source)
      if (!jobName) {
        retryItems = retryItems.concat(chunks.slice(chunkIndex).flatMap((c) => c.items))
        break
      }
      jobNames.push(jobName)
      submitted.push(...chunk.items.map((item) => ({ key: item.key, jobName })))
    } catch (err) {
      const message = extractOfetchErrorMessage(err)
      console.warn(`[anthropic-batch] submit failed: ${message}`)
      if (!isTransientBatchError(err)) {
        await recordLlmBatchCapability('claude-proxy', { ok: false, message, source })
      }
      retryItems = retryItems.concat(chunks.slice(chunkIndex).flatMap((c) => c.items))
      break
    }
  }
  if (jobNames.length === 0) return null
  return { jobName: jobNames.join(','), submitted, retryItems }
}

export async function pollAnthropicBatch(jobName: string, config: LlmConfig): Promise<PollResult> {
  try {
    const resp = await $fetch<{ processing_status?: string }>(`${apiBase(config)}/v1/messages/batches/${jobName}`, {
      headers: {
        'anthropic-version': '2023-06-01',
        ...authHeaders(config),
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (resp.processing_status === 'ended') return { state: 'succeeded' }
    if (resp.processing_status === 'in_progress' || resp.processing_status === 'canceling') return { state: 'pending' }
    console.warn(`[anthropic-batch] unrecognized status for ${jobName}: ${resp.processing_status ?? '<missing>'}`)
    return { state: 'pending' }
  } catch (err) {
    console.warn(`[anthropic-batch] poll failed for ${jobName}: ${(err as Error).message}`)
    return { state: 'pending' }
  }
}

export async function fetchAnthropicBatchResults(
  jobName: string,
  config: LlmConfig,
  customIdMap: Record<string, string>,
): Promise<{ key: string; extraction: ClampedExtraction | null; error?: string | null }[]> {
  const text = await $fetch<string>(`${apiBase(config)}/v1/messages/batches/${jobName}/results`, {
    headers: {
      'anthropic-version': '2023-06-01',
      ...authHeaders(config),
    },
    signal: AbortSignal.timeout(120_000),
    responseType: 'text',
  })
  const out: { key: string; extraction: ClampedExtraction | null; error?: string | null }[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: { custom_id?: unknown; result?: { type?: unknown; message?: unknown; error?: { message?: unknown } } }
    try {
      parsed = JSON.parse(trimmed) as typeof parsed
    } catch (err) {
      console.warn(`[anthropic-batch] failed to parse result line: ${(err as Error).message}`)
      continue
    }
    if (typeof parsed.custom_id !== 'string') continue
    const key = customIdMap[parsed.custom_id] ?? parsed.custom_id
    const resultType = typeof parsed.result?.type === 'string' ? parsed.result.type : undefined
    const raw = resultType === 'succeeded' ? parseExtractionResponse(parsed.result!.message) : null
    const extraction = raw ? clampExtraction(raw) : null
    const error = extraction
      ? null
      : (typeof parsed.result?.error?.message === 'string' ? parsed.result.error.message : undefined) ??
        (resultType && resultType !== 'succeeded' ? `Batch-Ergebnis: ${resultType}` : 'Keine gültige Extraktion in der Batch-Antwort')
    out.push({ key, extraction, error })
  }
  return out
}
