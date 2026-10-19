/**
 * The request path an auth middleware must compare its guarded prefixes
 * against. h3 routes on the *decoded* path but leaves `node.req.url` raw, so
 * a prefix check on the raw URL lets `/api/%64ata/...` reach the `/api/data/`
 * handlers unauthenticated. Strips the query string, decodes and lowercases so
 * encoded or differently-cased variants can't slip past; malformed encoding
 * keeps the raw path (fail closed: it then matches no route either).
 */
export function guardedRequestPath(rawUrl: string | undefined): string {
  let path = (rawUrl ?? '').split('?')[0]!
  try {
    path = decodeURIComponent(path)
  } catch {
    // keep raw path
  }
  return path.toLowerCase()
}
