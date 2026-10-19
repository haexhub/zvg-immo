// Shared retry for idempotent GETs against upstream portals and document
// hosts that drop connections now and then (undici's bare "fetch failed").
// Unlike llm-errors.ts's connection checks, which guard non-idempotent LLM
// POSTs, a reset here is always safe to resend.

const RETRIES = 2
const BASE_DELAY_MS = 500
/** OS/undici codes of a connection that broke or never came up — worth a
 *  second try. ENOTFOUND (the host does not exist) is deliberately absent. */
const TRANSIENT_CODES = /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR_(?!ABORTED)\w+)$/

/** An upstream answer that is a temporary failure (5xx, zvg-portal's bare
 *  `error` body under load) rather than a verdict on the request. Throw it
 *  inside retryTransient to have it retried like a network error. */
export class TransientUpstreamError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransientUpstreamError'
  }
}

/** The OS/undici error code, from the error itself or fetch()'s `cause`. */
function networkErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown })?.code ?? (err as { cause?: { code?: unknown } })?.cause?.code
  return typeof code === 'string' ? code : undefined
}

export function isTransientFetchError(err: unknown): boolean {
  if (err instanceof TransientUpstreamError) return true
  const code = networkErrorCode(err)
  if (code) return TRANSIENT_CODES.test(code)
  // undici occasionally rejects with "fetch failed" and no coded cause.
  return err instanceof TypeError && err.message === 'fetch failed'
}

/** The error message plus the network code fetch() hides in `cause` —
 *  "fetch failed" alone does not say whether the host reset or timed out. */
export function describeFetchError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const code = networkErrorCode(err)
  return code && !message.includes(code) ? `${message} (${code})` : message
}

/** Runs `attempt` and re-runs it up to twice with jittered backoff when it
 *  throws a transient network error or TransientUpstreamError. Anything else
 *  — a 4xx, a 429, a parse error — is rethrown at once. */
export async function retryTransient<T>(attempt: () => Promise<T>): Promise<T> {
  for (let n = 0; ; n++) {
    try {
      return await attempt()
    } catch (err) {
      if (n >= RETRIES || !isTransientFetchError(err)) throw err
    }
    // Jittered so concurrent workers hit by the same blip don't retry in lockstep.
    await new Promise((resolve) => setTimeout(resolve, BASE_DELAY_MS * 2 ** n * (0.5 + Math.random())))
  }
}
