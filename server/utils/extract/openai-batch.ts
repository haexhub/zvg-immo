import {
  buildParts,
  clampExtraction,
  SYSTEM_PROMPT,
  UNIVERSAL_AUCTION_SCHEMA,
  UNIVERSAL_AUCTION_SCHEMA_NAME,
  type ClampedExtraction,
  type LlmConfig,
  type LlmInput,
} from './llm'
import { parseOpenAiExtractionResponse, toOpenAiContent } from './providers/openai-compatible'
import { apiBase, customIdForKey, extractBatchItemErrorMessage, extractOfetchErrorMessage, isTransientBatchError } from './batch-shared'
import { insertLlmBatchJob, recordLlmBatchCapability } from '../llm-batch-jobs'
import type { PollResult } from './gemini-batch'
import type { LlmBatchSubmitResult } from './llm-batch'

const MAX_OPENAI_BATCH_REQUESTS = 50_000
const MAX_OPENAI_BATCH_FILE_BYTES = 200 * 1024 * 1024
const OPENAI_BATCH_FILE_HEADROOM_BYTES = 1024 * 1024

function authHeaders(config: LlmConfig): Record<string, string> {
  return config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}
}

function buildBatchLine(customId: string, input: LlmInput, config: LlmConfig): string | null {
  const parts = buildParts(input)
  if (parts.length === 0) return null
  return JSON.stringify({
    custom_id: customId,
    method: 'POST',
    url: '/v1/chat/completions',
    body: {
      model: config.model,
      max_tokens: config.maxTokens ?? 4096,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: toOpenAiContent(parts) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: UNIVERSAL_AUCTION_SCHEMA_NAME,
          schema: UNIVERSAL_AUCTION_SCHEMA,
          strict: true,
        },
      },
    },
  })
}

async function uploadJsonl(
  jsonl: string,
  config: LlmConfig,
  source: 'enrich' | 'reprocess',
): Promise<string | null> {
  const form = new FormData()
  form.append('purpose', 'batch')
  form.append(
    'file',
    new Blob([jsonl], { type: 'application/jsonl' }),
    `zvg-immo-batch-${Date.now()}.jsonl`,
  )
  const file = await $fetch<{ id?: string }>(`${apiBase(config)}/files`, {
    method: 'POST',
    headers: authHeaders(config),
    body: form,
    signal: AbortSignal.timeout(120_000),
  })
  if (!file.id) {
    const message = 'file upload response had no file id'
    console.warn(`[openai-batch] ${message}`)
    await recordLlmBatchCapability('openai-compatible', { ok: false, message, source })
    return null
  }
  return file.id
}

async function submitOpenAiRequestChunk(
  lines: string[],
  customIdMap: Record<string, string>,
  config: LlmConfig,
  source: 'enrich' | 'reprocess',
): Promise<string | null> {
  const fileId = await uploadJsonl(lines.join('\n'), config, source)
  if (!fileId) return null
  const batch = await $fetch<{ id?: string }>(`${apiBase(config)}/batches`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(config),
    },
    body: {
      input_file_id: fileId,
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
      metadata: { source: `zvg-immo-${source}` },
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (!batch.id) {
    const message = 'create response had no batch id'
    console.warn(`[openai-batch] ${message}`)
    await recordLlmBatchCapability('openai-compatible', { ok: false, message, source })
    return null
  }
  // OpenAI accepted the request — batch submission itself works for this
  // account/model, independent of whether our own bookkeeping below does.
  await recordLlmBatchCapability('openai-compatible', { ok: true, message: null, source })
  const recorded = await insertLlmBatchJob({
    jobName: batch.id,
    source,
    itemCount: lines.length,
    customIdMap,
  })
  if (!recorded) {
    console.warn(`[openai-batch] failed to record job ${batch.id} — treating submission as failed`)
    try {
      await $fetch(`${apiBase(config)}/batches/${batch.id}/cancel`, {
        method: 'POST',
        headers: authHeaders(config),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (err) {
      console.warn(`[openai-batch] failed to cancel orphaned job ${batch.id}: ${(err as Error).message}`)
    }
    return null
  }
  return batch.id
}

export async function submitOpenAiBatch(
  items: { key: string; input: LlmInput }[],
  config: LlmConfig,
  source: 'enrich' | 'reprocess',
): Promise<LlmBatchSubmitResult | null> {
  if (!config.apiKey) return null

  const chunks: Array<{
    lines: string[]
    customIdMap: Record<string, string>
    items: Array<{ key: string; input: LlmInput }>
  }> = []
  const skipped: Array<{ key: string; input: LlmInput }> = []
  let currentLines: string[] = []
  let currentCustomIdMap: Record<string, string> = {}
  let currentItems: Array<{ key: string; input: LlmInput }> = []
  let currentBytes = 0

  for (const [index, item] of items.entries()) {
    const customId = customIdForKey(item.key, index)
    const line = buildBatchLine(customId, item.input, config)
    if (!line) {
      skipped.push(item)
      continue
    }
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (lineBytes > MAX_OPENAI_BATCH_FILE_BYTES - OPENAI_BATCH_FILE_HEADROOM_BYTES) {
      console.warn(`[openai-batch] skipping oversized request for ${item.key}`)
      skipped.push(item)
      continue
    }
    const separatorBytes = currentLines.length > 0 ? 1 : 0
    if (
      currentLines.length >= MAX_OPENAI_BATCH_REQUESTS ||
      (
        currentLines.length > 0 &&
        currentBytes + separatorBytes + lineBytes > MAX_OPENAI_BATCH_FILE_BYTES - OPENAI_BATCH_FILE_HEADROOM_BYTES
      )
    ) {
      chunks.push({ lines: currentLines, customIdMap: currentCustomIdMap, items: currentItems })
      currentLines = []
      currentCustomIdMap = {}
      currentItems = []
      currentBytes = 0
    }
    currentBytes += (currentLines.length > 0 ? 1 : 0) + lineBytes
    currentLines.push(line)
    currentCustomIdMap[customId] = item.key
    currentItems.push(item)
  }
  if (currentLines.length > 0) chunks.push({ lines: currentLines, customIdMap: currentCustomIdMap, items: currentItems })
  if (chunks.length === 0) return null

  const jobNames: string[] = []
  const submitted: LlmBatchSubmitResult['submitted'] = []
  let retryItems = [...skipped]
  for (const [chunkIndex, chunk] of chunks.entries()) {
    try {
      const jobName = await submitOpenAiRequestChunk(chunk.lines, chunk.customIdMap, config, source)
      if (!jobName) {
        retryItems = retryItems.concat(chunks.slice(chunkIndex).flatMap((c) => c.items))
        break
      }
      jobNames.push(jobName)
      submitted.push(...chunk.items.map((item) => ({ key: item.key, jobName })))
    } catch (err) {
      const message = extractOfetchErrorMessage(err)
      console.warn(`[openai-batch] submit failed: ${message}`)
      if (!isTransientBatchError(err)) {
        await recordLlmBatchCapability('openai-compatible', { ok: false, message, source })
      }
      retryItems = retryItems.concat(chunks.slice(chunkIndex).flatMap((c) => c.items))
      break
    }
  }
  if (jobNames.length === 0) return null
  return { jobName: jobNames[0]!, submitted, retryItems }
}

export async function pollOpenAiBatch(jobName: string, config: LlmConfig): Promise<PollResult> {
  try {
    const resp = await $fetch<{
      status?: string
      output_file_id?: string | null
      errors?: { data?: Array<{ message?: string }> } | null
    }>(`${apiBase(config)}/batches/${jobName}`, {
      headers: authHeaders(config),
      signal: AbortSignal.timeout(30_000),
    })
    const errorMessage = resp.errors?.data?.[0]?.message
    if (resp.status === 'completed') {
      if (!resp.output_file_id) {
        console.warn(`[openai-batch] job ${jobName} completed without an output_file_id`)
        return { state: 'failed' }
      }
      return { state: 'succeeded', resultFileName: resp.output_file_id }
    }
    if (resp.status === 'failed' || resp.status === 'cancelled') return { state: 'failed', errorMessage }
    if (resp.status === 'expired') return { state: 'expired', errorMessage }
    return { state: 'pending' }
  } catch (err) {
    console.warn(`[openai-batch] poll failed for ${jobName}: ${(err as Error).message}`)
    return { state: 'pending' }
  }
}

export async function fetchOpenAiBatchResults(
  outputFileId: string,
  config: LlmConfig,
  customIdMap: Record<string, string>,
): Promise<{ key: string; extraction: ClampedExtraction | null; error?: string | null }[]> {
  const text = await $fetch<string>(`${apiBase(config)}/files/${outputFileId}/content`, {
    headers: authHeaders(config),
    signal: AbortSignal.timeout(120_000),
    responseType: 'text',
  })
  const out: { key: string; extraction: ClampedExtraction | null; error?: string | null }[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: {
      custom_id?: unknown
      response?: { status_code?: unknown; body?: unknown } | null
      error?: unknown
    }
    try {
      parsed = JSON.parse(trimmed) as typeof parsed
    } catch (err) {
      console.warn(`[openai-batch] failed to parse result line: ${(err as Error).message}`)
      continue
    }
    if (typeof parsed.custom_id !== 'string') continue
    const key = customIdMap[parsed.custom_id] ?? parsed.custom_id
    const raw =
      parsed.error || parsed.response?.status_code !== 200
        ? null
        : parseOpenAiExtractionResponse(parsed.response.body)
    const extraction = raw ? clampExtraction(raw) : null
    out.push({
      key,
      extraction,
      error: extraction ? null : (extractBatchItemErrorMessage(parsed.error, parsed.response) ?? 'Keine gültige Extraktion in der Batch-Antwort'),
    })
  }
  return out
}
