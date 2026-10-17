// Sends extraction requests through haex-claude-proxy's Anthropic-compatible
// `/v1/messages` endpoint, using a forced tool call to get JSON back.
// Transitional provider (Anthropic-Messages-Format, not OpenAI-compatible)
// until the Claude path is retired in favor of OpenAiCompatibleProvider/
// GeminiNativeProvider.

import type { ContentPart, ExtractionProvider, ExtractionRequest, LlmConfig, LlmUsage } from '../llm'
import {
  CONNECTION_RETRY_DELAYS_MS,
  isConnectionDroppedError,
  isRateLimitError,
  isTransientRequestError,
  LlmProviderError,
  TRANSIENT_RETRY_DELAYS_MS,
} from '../llm-errors'

type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

/** Pull the structured object out of the proxy's `final_result` tool_use block. */
export function parseExtractionResponse(resp: unknown): Record<string, unknown> | null {
  if (!resp || typeof resp !== 'object') return null
  const content = (resp as { content?: unknown }).content
  if (!Array.isArray(content)) return null
  const block = content.find(
    (c): c is { input: unknown } =>
      !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'tool_use' &&
      (c as { name?: unknown }).name === 'final_result',
  )
  if (!block || typeof block.input !== 'object' || block.input == null) return null
  return block.input as Record<string, unknown>
}

// The proxy's OAuth/Claude-CLI path allows large multimodal requests up to
// 10 minutes. Scanned appraisals can legitimately need several minutes: the
// production proxy completed one after 288s. Keep the client-side deadline
// above that backstop, otherwise the app aborts first, kills the proxy's CLI
// process, and every retry is recorded as a provider failure.
const CLAUDE_PROXY_REQUEST_TIMEOUT_MS = 11 * 60 * 1000

/** Upper bound for all text sent to the proxy in one request, in UTF-8 *bytes*.
 *  The proxy hands the whole prompt to the `claude` CLI as a single command-line
 *  argument, and Linux rejects any one argument over 128 KiB (MAX_ARG_STRLEN)
 *  with E2BIG — which the proxy does not catch, so the *whole proxy process
 *  crashes* and every in-flight request dies with it. The document-text caps
 *  upstream count characters (80,000), but Cyrillic/Greek text takes 2 bytes
 *  per character: a Bulgarian appraisal of 78,166 characters crashed the proxy
 *  on every reprocess run (34 crashes in 26 h). Kept well below 128 KiB to
 *  leave room for the proxy's own prompt wrapper. */
export const MAX_PROXY_TEXT_BYTES = 100_000
const TRUNCATION_MARKER = '\n[… Text wegen Größenlimit gekürzt]'

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** Cuts `text` to at most `maxBytes` UTF-8 bytes without splitting a character. */
function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')
  // A multi-byte character cut in half decodes to U+FFFD at the end.
  return cut.endsWith('\uFFFD') ? cut.slice(0, -1) : cut
}

/** Shrinks the largest text block(s) until all text fits MAX_PROXY_TEXT_BYTES.
 *  Only the oversized document text is shortened; the short instruction blocks
 *  around it stay intact. Returns the input untouched when it already fits. */
export function clampTextToProxyLimit<T extends { type: string; text?: string }>(blocks: T[]): T[] {
  const sizes = blocks.map((b) => (b.type === 'text' && b.text != null ? byteLength(b.text) : 0))
  let excess = sizes.reduce((a, b) => a + b, 0) - MAX_PROXY_TEXT_BYTES
  if (excess <= 0) return blocks
  const out = blocks.map((b) => ({ ...b }))
  while (excess > 0) {
    let largest = 0
    for (let i = 1; i < sizes.length; i++) if (sizes[i]! > sizes[largest]!) largest = i
    const block = out[largest]!
    const target = Math.max(0, sizes[largest]! - excess - byteLength(TRUNCATION_MARKER))
    if (target >= sizes[largest]!) break
    block.text = truncateToBytes(block.text ?? '', target) + TRUNCATION_MARKER
    const newSize = byteLength(block.text)
    excess -= sizes[largest]! - newSize
    sizes[largest] = newSize
    if (newSize <= byteLength(TRUNCATION_MARKER)) break
  }
  console.warn(`[extract/llm] claude-proxy: text exceeded ${MAX_PROXY_TEXT_BYTES} bytes, truncated to fit the CLI argument limit`)
  return out
}

/** This proxy path forwards only text and image blocks: `document` parts are
 *  intentionally dropped here — the transitional proxy doesn't relay native
 *  PDF documents — so callers on this provider rely on the `pdfText`/
 *  `pdfPageImages` parts buildParts already produced instead (see ../llm.ts). */
function toClaudeContent(parts: ContentPart[]): ClaudeContentBlock[] {
  const blocks: ClaudeContentBlock[] = []
  for (const part of parts) {
    if (part.type === 'text') blocks.push({ type: 'text', text: part.text })
    else if (part.type === 'image') {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.data } })
    }
  }
  return blocks
}

/** Reads the Anthropic Messages API's `usage.{input_tokens,output_tokens}`. */
export function parseClaudeUsage(resp: unknown): LlmUsage {
  const usage = (resp as { usage?: unknown })?.usage as { input_tokens?: unknown; output_tokens?: unknown } | undefined
  const inputTokens = typeof usage?.input_tokens === 'number' ? usage.input_tokens : null
  const outputTokens = typeof usage?.output_tokens === 'number' ? usage.output_tokens : null
  return { inputTokens, outputTokens }
}

export class ClaudeProxyProvider implements ExtractionProvider {
  constructor(private config: LlmConfig) {}

  async extract(
    req: ExtractionRequest,
    opts?: { onRequestError?: (err: unknown) => void; onUsage?: (usage: LlmUsage) => void },
  ): Promise<Record<string, unknown> | null> {
    const body = {
      model: this.config.model,
      // Raised from 512: the response now also carries `insights` (up to two
      // 20-item string lists plus free text) and a per-candidate-photo
      // curation array — the old budget truncated the larger JSON payload.
      max_tokens: this.config.maxTokens ?? 4096,
      system: req.systemPrompt,
      messages: [{ role: 'user', content: clampTextToProxyLimit(toClaudeContent(req.parts)) }],
      tools: [
        {
          name: 'final_result',
          description: 'Gib die extrahierten Eckdaten im universellen Auktions-JSON zurück.',
          input_schema: req.schema,
        },
      ],
      tool_choice: { type: 'tool', name: 'final_result' },
    }
    let resp: unknown
    for (let attempt = 0; ; attempt++) {
      try {
        // Bound the request: the proxy spawns a `claude` subprocess per call, so a
        // stuck spawn (or upstream stall) would keep this promise pending forever
        // and — because the enrich task awaits every worker via Promise.all — block
        // the whole run. This is deliberately just above the proxy's 10-minute
        // subprocess backstop; see CLAUDE_PROXY_REQUEST_TIMEOUT_MS above.
        resp = await $fetch(`${this.config.baseUrl.replace(/\/$/, '')}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
            ...(this.config.apiKey ? { 'x-api-key': this.config.apiKey } : {}),
          },
          body,
          signal: AbortSignal.timeout(CLAUDE_PROXY_REQUEST_TIMEOUT_MS),
        })
        break
      } catch (err) {
        // Rethrow a rate limit/quota error instead of swallowing it to null —
        // see isRateLimitError() — so it isn't counted toward the retry-lockout.
        if (isRateLimitError(err)) throw err
        // A transient failure (e.g. OpenRouter's thin-provider-pool 404, "no
        // endpoint available right now") gets a couple of quick retries on
        // the same model before giving up — see TRANSIENT_RETRY_DELAYS_MS. A
        // 400/401/403 will fail identically every time, so skip straight to
        // giving up instead of paying the retry delay for nothing.
        // A reprocess call passes onRequestError.  Its prompts can include
        // multiple rendered document pages and are consequently expensive on
        // the Claude subscription. Retrying a proxy 5xx/timeout immediately
        // has repeatedly spent the same input budget three times without a
        // usable result. Surface that first failure to reprocess instead: it
        // aborts the run (or tries a configured fallback) without increasing
        // every auction's llm_failures counter. Lightweight callers that do
        // not pass the callback retain the short transient retry behaviour.
        if (!opts?.onRequestError && isTransientRequestError(err) && attempt < TRANSIENT_RETRY_DELAYS_MS.length) {
          console.warn(
            `[extract/llm] request failed, retry ${attempt + 1}/${TRANSIENT_RETRY_DELAYS_MS.length}: ${(err as Error).message}`,
          )
          await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAYS_MS[attempt]))
          continue
        }
        // The proxy is restarted from time to time (auto-update swapping its
        // image), which drops every in-flight connection at once. Reprocess
        // would read that as "provider unavailable" and stop the whole run, so
        // wait out the restart and re-send — but only for a dropped connection,
        // never for an error status or a timeout (see isConnectionDroppedError).
        if (opts?.onRequestError && isConnectionDroppedError(err) && attempt < CONNECTION_RETRY_DELAYS_MS.length) {
          console.warn(
            `[extract/llm] claude-proxy connection dropped, retry ${attempt + 1}/${CONNECTION_RETRY_DELAYS_MS.length} in ${CONNECTION_RETRY_DELAYS_MS[attempt]! / 1000}s: ${(err as Error).message}`,
          )
          await new Promise((resolve) => setTimeout(resolve, CONNECTION_RETRY_DELAYS_MS[attempt]))
          continue
        }
        // `onRequestError` is observability, not permission to turn a
        // provider outage into a per-auction extraction failure.  Always
        // reject after reporting it so reprocess can stop safely.
        opts?.onRequestError?.(err)
        throw new LlmProviderError('claude-proxy', (err as Error).message, { cause: err })
      }
    }
    opts?.onUsage?.(parseClaudeUsage(resp))
    const parsed = parseExtractionResponse(resp)
    if (parsed) return parsed
    // Unlike a request failure above, an unparseable response (e.g. JSON cut
    // off at max_tokens) is about this input, not a proxy outage: reprocess
    // counts it as a per-auction failure instead of stopping the whole run.
    if (opts?.onRequestError) {
      const stopReason = (resp as { stop_reason?: unknown })?.stop_reason
      console.warn(`[extract/llm] unparseable response (stop_reason=${String(stopReason)})`)
      return null
    }
    throw new LlmProviderError('claude-proxy', 'ungültige oder leere Provider-Antwort')
  }
}
