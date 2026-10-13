// Central definition of what qualifies as a "safe" path segment for a
// platform id or externalId. Used by both writers (enrich task creating image
// directories) and readers (/api/auction-image, /api/auction) so both sides
// agree — an unsafe id gets rejected at write time, and the read endpoint
// enforces the same shape defensively.

/**
 * Ascii-slug: leading alnum, then alnum / `_` / `-`, max 64 chars. Rejects
 * anything that could escape a directory (`.`, `/`, `\`, `..`), platform
 * separators, whitespace, and non-ascii.
 */
export const SAFE_SEGMENT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i

export function isSafePathSegment(s: string): boolean {
  return SAFE_SEGMENT_RE.test(s)
}

/** Row ids in path params: checked up front so a malformed value is a 400
 * instead of a Postgres `invalid input syntax for type uuid` 500. */
export function isUuidSegment(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}
