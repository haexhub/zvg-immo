/**
 * A source (portal) is currently refusing requests with rate limiting and its
 * crawler has already backed off as far as it is willing to. Thrown by a
 * crawler's fetch layer when it stops asking, so callers can tell "come back
 * later" apart from a per-auction failure: the enrich worker skips the rest of
 * that platform's detail fetches for the run instead of recording one error
 * per auction (alo.bg produced ~85,000 such rows in a week).
 */
export class SourceRateLimitedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceRateLimitedError'
  }
}

export function isSourceRateLimited(err: unknown): err is SourceRateLimitedError {
  return err instanceof SourceRateLimitedError
}
