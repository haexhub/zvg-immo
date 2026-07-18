export interface InMemoryRateLimitOptions {
  max: number
  windowMs: number
  maxKeys?: number
}

export interface InMemoryRateLimitState {
  attempts: Map<string, number[]>
}

export function createInMemoryRateLimitState(): InMemoryRateLimitState {
  return { attempts: new Map() }
}

function freshHits(list: number[], now: number, windowMs: number): number[] {
  const cutoff = now - windowMs
  return list.filter((t) => t > cutoff)
}

function ensureRoom(state: InMemoryRateLimitState, now: number, opts: InMemoryRateLimitOptions): void {
  const maxKeys = opts.maxKeys ?? 10_000
  if (state.attempts.size < maxKeys) return
  const cutoff = now - opts.windowMs
  for (const [key, list] of state.attempts) {
    const latest = list[list.length - 1]
    if (latest === undefined || latest <= cutoff) state.attempts.delete(key)
  }
  if (state.attempts.size < maxKeys) return
  const firstKey = state.attempts.keys().next().value
  if (firstKey !== undefined) state.attempts.delete(firstKey)
}

export function checkInMemoryRateLimit(
  state: InMemoryRateLimitState,
  key: string,
  now: number,
  opts: InMemoryRateLimitOptions,
): boolean {
  const list = state.attempts.get(key)
  if (!list) return true
  const fresh = freshHits(list, now, opts.windowMs)
  if (fresh.length === 0) {
    state.attempts.delete(key)
    return true
  }
  if (fresh.length !== list.length) state.attempts.set(key, fresh)
  return fresh.length < opts.max
}

export function recordInMemoryRateLimitHit(
  state: InMemoryRateLimitState,
  key: string,
  now: number,
  opts: InMemoryRateLimitOptions,
): void {
  ensureRoom(state, now, opts)
  const list = state.attempts.get(key) ?? []
  const fresh = freshHits(list, now, opts.windowMs)
  fresh.push(now)
  state.attempts.set(key, fresh)
}
