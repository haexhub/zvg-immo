// Open-Meteo's free tier caps traffic at 600 calls/min, shared across all its
// subdomains for one client IP (open-meteo.com/en/pricing). cams-air-quality.ts
// calls this for every auction on every external-enrichment run; open-meteo-
// climate.ts stacks its own (rarer, but heavier) archive calls on cold cells
// in the same run. Combined, with no pacing at all, they blew straight
// through the cap — observed in prod on 2026-08-07: 4296 of 4307 climate
// requests came back 429, killing the climate chart for virtually every
// auction. Same pacing idiom as geocode.ts / crawlers/boe/fetch.ts: serialise
// request starts MIN_GAP_MS apart, and retry a 429 a few times with backoff
// instead of treating it as a hard failure.

const MIN_GAP_MS = 150
let lastRequestAt = 0
let queue: Promise<void> = Promise.resolve()

// A queued entry's wait (both the pacing gap below and the retry backoff in
// fetchOpenMeteo) races the caller's own abort signal, so a caller's timeout
// fires promptly instead of being stuck behind the gate or a long
// Retry-After — it then hits fetchImpl with an already-aborted signal, which
// rejects immediately with the same AbortError callers already handle.
function gate(signal: AbortSignal | undefined): Promise<void> {
  const prev = queue
  let release!: () => void
  queue = new Promise<void>((resolve) => {
    release = resolve
  })
  return prev.then(async () => {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now()
    if (wait > 0) await sleep(wait, signal)
    // Don't consume the pacing slot for a call that gave up mid-wait.
    if (!signal?.aborted) lastRequestAt = Date.now()
    release()
  })
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

const MAX_RETRIES = 3
const RETRY_BASE_MS = 5_000

export async function fetchOpenMeteo(
  url: string,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    await gate(signal)
    const res = await fetchImpl(url, { signal })
    if (res.status !== 429 || attempt >= MAX_RETRIES) return res
    await sleep(retryDelayMs(res.headers.get('retry-after'), attempt), signal)
  }
}

function retryDelayMs(retryAfterHeader: string | null, attempt: number): number {
  const seconds = Number(retryAfterHeader)
  if (retryAfterHeader && Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000
  }
  // Retry-After may also be an HTTP-date instead of a delay in seconds.
  const retryAt = retryAfterHeader ? Date.parse(retryAfterHeader) : NaN
  return Number.isFinite(retryAt)
    ? Math.max(0, retryAt - Date.now())
    : RETRY_BASE_MS * 2 ** attempt
}
