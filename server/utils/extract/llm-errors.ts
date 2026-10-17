// Provider error types and retry classification, shared by llm.ts and the
// provider implementations. Kept apart from llm.ts so the providers do not
// import back into the module that instantiates them.

export class LlmProviderError extends Error {
  readonly provider: string

  constructor(provider: string, message: string, options?: { cause?: unknown }) {
    super(`${provider}: ${message}`, options)
    this.name = 'LlmProviderError'
    this.provider = provider
  }
}

export function isLlmProviderError(error: unknown): error is LlmProviderError {
  return error instanceof LlmProviderError
}

/** Whether a thrown $fetch error was an HTTP 429 (rate limit/quota exceeded).
 *  Providers rethrow rather than swallow this to null so a capacity outage
 *  (observed in prod on Gemini's free tier — see gemini-native.ts) never
 *  counts toward extraction's retry-lockout: reprocess.ts's per-candidate
 *  try/catch skips a thrown error without touching the cache entry, leaving
 *  `llmFailures` untouched so the auction is retried again next run instead
 *  of being permanently downgraded to rules-only after MAX_LLM_FAILURES
 *  unrelated capacity failures. */
export function isRateLimitError(err: unknown): boolean {
  return (err as { response?: { status?: number } })?.response?.status === 429
}

/** Every `quotaId` Google attached to a QuotaFailure detail in the error body
 *  (e.g. 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'). Empty for
 *  providers that don't report quota details. */
function quotaIds(err: unknown): string[] {
  const details = (err as { data?: { error?: { details?: unknown } } })?.data?.error?.details
  if (!Array.isArray(details)) return []
  const ids: string[] = []
  for (const detail of details) {
    const violations = (detail as { violations?: unknown })?.violations
    if (!Array.isArray(violations)) continue
    for (const violation of violations) {
      const id = (violation as { quotaId?: unknown })?.quotaId
      if (typeof id === 'string') ids.push(id)
    }
  }
  return ids
}

/**
 * Whether a 429 is a *per-day* quota rather than a per-minute rate limit.
 * The distinction decides whether waiting can help at all: a per-minute limit
 * clears in seconds, a daily one only at midnight Pacific. Retrying the
 * latter burns MAX_RETRIES × MIN_REQUEST_GAP_MS (~50 s) per candidate for
 * nothing — measured in prod on 2026-07-31, where it cut reprocess throughput
 * from ~300 to ~58 auctions per hourly run.
 *
 * Deliberately conservative: only true when the provider actually says so via
 * a `quotaId` containing 'PerDay'. Providers that report no quota details keep
 * their previous retry behaviour rather than being guessed at.
 */
export function isDailyQuotaError(err: unknown): boolean {
  return isRateLimitError(err) && quotaIds(err).some((id) => /perday/i.test(id))
}

/** Whether the current model/profile is the problem — rate-limited/over
 *  quota, or a provider-level failure such as a model id that no longer
 *  resolves (see gemini-native.ts) — as opposed to a caller-side bug. Callers
 *  configured with a fallback chain (see app-settings.ts's
 *  getLlmProviderOverrideChain) use this to decide whether to try the next
 *  model instead of giving up. */
export function isLlmProviderUnavailable(err: unknown): boolean {
  return isRateLimitError(err) || isLlmProviderError(err)
}

/** Backoff between retries of a single transient request failure — e.g.
 *  OpenRouter's thin-provider-pool 404 ("no endpoint available right now"),
 *  which typically clears within a few seconds. Deliberately short: this
 *  retries the *same* model before a caller gives up on it, not before
 *  trying the next configured one in the chain. Each provider retries this
 *  inline around its own $fetch call rather than through a shared generic
 *  wrapper — wrapping $fetch's routed overload type through a generic
 *  function tripped up vue-tsc ("excessive stack depth"). */
export const TRANSIENT_RETRY_DELAYS_MS = [1_000, 3_000]

/** Whether a request failure is worth retrying on the same model at all — as
 *  opposed to a 400/401/403 that will fail identically every time and should
 *  go straight to giving up (or the next configured chain model) instead of
 *  paying TRANSIENT_RETRY_DELAYS_MS for a retry that can't succeed. No HTTP
 *  status at all (network error, DNS failure, the AbortSignal.timeout()
 *  every provider sets) always counts as transient. 404 is deliberately
 *  included — it's OpenRouter's thin-provider-pool signal ("no endpoint
 *  available right now" for the requested model), the case this retry exists
 *  for — even though it can also mean "this model id doesn't exist" for a
 *  genuinely broken config; the status code can't tell those apart. */
export function isTransientRequestError(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status
  if (status == null) return true
  return status === 404 || status === 408 || status >= 500
}

/** Waits before re-sending a request whose connection dropped without any
 *  response (see isConnectionDroppedError). Sized to outlast a restart of the
 *  claude-proxy container (a few seconds, e.g. `podman auto-update` swapping
 *  in a new image), not an actual outage — after the last wait the caller
 *  gives up as before. */
export const CONNECTION_RETRY_DELAYS_MS = [5_000, 15_000, 30_000]

/** Whether a request failed before the connection could deliver the request —
 *  as opposed to an HTTP error status, a timeout, or an ambiguous disconnect.
 *  Only errors whose operating-system code proves that no connection was
 *  established are safe to retry for reprocess's expensive multimodal
 *  prompts. A reset/closed socket can happen after the proxy accepted the
 *  POST, so those errors must not be retried without request deduplication. */
export function isConnectionDroppedError(err: unknown): boolean {
  if ((err as { response?: unknown })?.response != null) return false
  const cause = (err as { cause?: { code?: unknown; name?: string; message?: string } })?.cause
  const text = `${(err as Error)?.name ?? ''} ${(err as Error)?.message ?? ''} ${cause?.name ?? ''} ${cause?.message ?? ''}`
  if (/abort|timeout|timed out/i.test(text)) return false
  const code = (err as { code?: unknown })?.code ?? cause?.code
  return typeof code === 'string' && /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)$/.test(code)
}

/** Whether a failed request lost its connection without any HTTP response —
 *  refused, reset, closed mid-flight (the claude-proxy being restarted) —
 *  as opposed to an error status or the client's own timeout. Unlike
 *  isConnectionDroppedError this includes resets that may have happened after
 *  the proxy accepted the request, so it never justifies re-sending the
 *  request; it only tells reprocess the provider may be coming back (see
 *  provider-recovery.ts) rather than being down. Accepts the provider's
 *  wrapped error as well as the raw fetch error. */
export function isConnectionLostError(err: unknown): boolean {
  const inner = isLlmProviderError(err) && err.cause != null ? err.cause : err
  if ((inner as { response?: unknown })?.response != null) return false
  const cause = (inner as { cause?: { name?: string; message?: string; code?: string } })?.cause
  const text = `${(inner as Error)?.name ?? ''} ${(inner as Error)?.message ?? ''} ${cause?.name ?? ''} ${cause?.message ?? ''} ${cause?.code ?? ''}`
  if (/abort|timeout|timed out/i.test(text)) return false
  return /fetch failed|ECONNREFUSED|ECONNRESET|EPIPE|UND_ERR_SOCKET|other side closed|terminated/i.test(text)
}
