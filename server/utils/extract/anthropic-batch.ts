// Anthropic Message Batches client for extraction. This speaks the same
// Anthropic Messages shape as ClaudeProxyProvider, but submits many requests
// to `/v1/messages/batches` and later consumes the JSONL results stream.

import { createHash } from 'node:crypto'
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
import { insertLlmBatchJob } from '../llm-batch-jobs'
import type { PollResult } from './gemini-batch'

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } }

function apiBase(config: LlmConfig): string {
  return config.baseUrl.replace(/\/$/, '')
}

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

function customIdForKey(key: string, index: number): string {
  const hash = createHash('sha256').update(key).digest('base64url').slice(0, 18)
  return `zvg_${index}_${hash}`.slice(0, 64)
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

export async function submitAnthropicBatch(
  items: { key: string; input: LlmInput }[],
  config: LlmConfig,
  source: 'enrich' | 'reprocess',
): Promise<string | null> {
  const requests: Record<string, unknown>[] = []
  const customIdMap: Record<string, string> = {}
  for (const [index, item] of items.entries()) {
    const customId = customIdForKey(item.key, index)
    const request = buildRequest(customId, item.input, config)
    if (!request) continue
    requests.push(request)
    customIdMap[customId] = item.key
  }
  if (requests.length === 0) return null

  try {
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
      console.warn('[anthropic-batch] create response had no batch id')
      return null
    }
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
  } catch (err) {
    console.warn(`[anthropic-batch] submit failed: ${(err as Error).message}`)
    return null
  }
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
): Promise<{ key: string; extraction: ClampedExtraction | null }[]> {
  try {
    const text = await $fetch<string>(`${apiBase(config)}/v1/messages/batches/${jobName}/results`, {
      headers: {
        'anthropic-version': '2023-06-01',
        ...authHeaders(config),
      },
      signal: AbortSignal.timeout(120_000),
      responseType: 'text',
    })
    const out: { key: string; extraction: ClampedExtraction | null }[] = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let parsed: { custom_id?: unknown; result?: { type?: unknown; message?: unknown } }
      try {
        parsed = JSON.parse(trimmed) as typeof parsed
      } catch (err) {
        console.warn(`[anthropic-batch] failed to parse result line: ${(err as Error).message}`)
        continue
      }
      if (typeof parsed.custom_id !== 'string') continue
      const key = customIdMap[parsed.custom_id] ?? parsed.custom_id
      const raw = parsed.result?.type === 'succeeded' ? parseExtractionResponse(parsed.result.message) : null
      out.push({ key, extraction: raw ? clampExtraction(raw) : null })
    }
    return out
  } catch (err) {
    console.warn(`[anthropic-batch] fetch results failed for ${jobName}: ${(err as Error).message}`)
    return []
  }
}
