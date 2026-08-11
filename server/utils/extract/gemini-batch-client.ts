import { clampExtraction, type ClampedExtraction, type LlmConfig } from './llm'
import { parseGeminiExtractionResponse } from './providers/gemini-native'
import { apiBase } from './batch-shared'

export interface PollResult { state: 'pending' | 'succeeded' | 'failed' | 'expired'; resultFileName?: string; errorMessage?: string }
const SUCCEEDED_STATES = new Set(['JOB_STATE_SUCCEEDED', 'BATCH_STATE_SUCCEEDED', 'SUCCEEDED'])
const FAILED_STATES = new Set(['JOB_STATE_FAILED', 'BATCH_STATE_FAILED', 'FAILED', 'JOB_STATE_CANCELLED', 'BATCH_STATE_CANCELLED', 'CANCELLED'])
const EXPIRED_STATES = new Set(['JOB_STATE_EXPIRED', 'BATCH_STATE_EXPIRED', 'EXPIRED'])
// See gemini-batch.ts's module-level UNVERIFIED note — checks several
// plausible field paths rather than committing to one unconfirmed layout.
function extractState(resp: Record<string, unknown>): string | null {
  const metadata = resp.metadata as Record<string, unknown> | undefined; const batch = (resp as { batch?: Record<string, unknown> }).batch
  return [metadata?.state, resp.state, batch?.state].find((state): state is string => typeof state === 'string') ?? null
}
function extractErrorMessage(resp: Record<string, unknown>): string | undefined {
  const metadata = resp.metadata as Record<string, unknown> | undefined; const batch = (resp as { batch?: Record<string, unknown> }).batch
  for (const candidate of [resp.error, metadata?.error, batch?.error]) {
    const error = candidate as { message?: unknown } | undefined
    if (typeof error?.message === 'string') return error.message
  }
}
function extractResultFileName(resp: Record<string, unknown>): string | null {
  const response = resp.response as Record<string, unknown> | undefined; const output = response?.output as Record<string, unknown> | undefined
  const destination = response?.destination as Record<string, unknown> | undefined; const dest = resp.dest as Record<string, unknown> | undefined
  const batch = resp.batch as Record<string, unknown> | undefined; const batchOutput = batch?.output as Record<string, unknown> | undefined; const batchDest = batch?.dest as Record<string, unknown> | undefined
  return [output?.responsesFile, output?.responses_file, destination?.fileName, destination?.file_name, response?.responsesFile, response?.responses_file, dest?.fileName, dest?.file_name, batchOutput?.responsesFile, batchOutput?.responses_file, batchDest?.fileName, batchDest?.file_name]
    .find((value): value is string => typeof value === 'string') ?? null
}
export async function pollGeminiBatch(jobName: string, config: LlmConfig): Promise<PollResult> {
  try {
    const response = await $fetch<Record<string, unknown>>(`${apiBase(config)}/v1beta/${jobName}`, { headers: { 'x-goog-api-key': config.apiKey ?? '' }, signal: AbortSignal.timeout(30_000) })
    const state = extractState(response)
    if (!state) {
      console.warn(`[gemini-batch] poll response for ${jobName} had no recognizable state field — treating as pending`)
      return { state: 'pending' }
    }
    if (SUCCEEDED_STATES.has(state)) {
      const resultFileName = extractResultFileName(response)
      if (!resultFileName) {
        console.warn(`[gemini-batch] job ${jobName} reported success but no result file name was found`)
        return { state: 'failed' }
      }
      return { state: 'succeeded', resultFileName }
    }
    if (FAILED_STATES.has(state)) return { state: 'failed', errorMessage: extractErrorMessage(response) }
    if (EXPIRED_STATES.has(state)) return { state: 'expired', errorMessage: extractErrorMessage(response) }
    return { state: 'pending' }
  } catch (err) { console.warn(`[gemini-batch] poll failed for ${jobName}: ${(err as Error).message}`); return { state: 'pending' } }
}
export async function fetchGeminiBatchResults(resultFileName: string, config: LlmConfig, customIdMap: Record<string, string> = {}): Promise<{ key: string; extraction: ClampedExtraction | null; error?: string | null }[]> {
  try {
    const text = await $fetch<string>(`${apiBase(config)}/download/v1beta/${resultFileName}:download`, { query: { alt: 'media' }, headers: { 'x-goog-api-key': config.apiKey ?? '' }, signal: AbortSignal.timeout(120_000), responseType: 'text' })
    const out: { key: string; extraction: ClampedExtraction | null; error?: string | null }[] = []; let lineIndex = 0
    for (const line of text.split('\n')) {
      const trimmed = line.trim(); if (!trimmed) continue; const indexKey = String(lineIndex++)
      let parsed: { key?: unknown; metadata?: unknown; response?: unknown; error?: unknown; candidates?: unknown }
      try { parsed = JSON.parse(trimmed) as typeof parsed } catch (err) { console.warn(`[gemini-batch] failed to parse result line: ${(err as Error).message}`); continue }
      const metadata = parsed.metadata as Record<string, unknown> | undefined
      const key = typeof parsed.key === 'string' ? parsed.key : typeof metadata?.key === 'string' ? metadata.key : customIdMap[indexKey]
      if (typeof key !== 'string') continue
      const response = parsed.response ?? (Array.isArray(parsed.candidates) ? parsed : null)
      const itemError = parsed.error as { message?: unknown } | undefined
      const raw = itemError ? null : parseGeminiExtractionResponse(response)
      const extraction = raw ? clampExtraction(raw) : null
      out.push({
        key,
        extraction,
        error: extraction ? null : ((typeof itemError?.message === 'string' ? itemError.message : undefined) ?? 'Keine gültige Extraktion in der Batch-Antwort'),
      })
    }
    return out
  } catch (err) { console.warn(`[gemini-batch] fetch results failed: ${(err as Error).message}`); return [] }
}
