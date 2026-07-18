// Shared page/pageSize parsing for /api/data/v1/* (auctions.get.ts,
// observations.get.ts). Rejects non-finite/unsafe values (e.g. `page=Infinity`)
// instead of letting them fall through Math.trunc/`||` into the slice/offset
// math, falling back to the given defaults exactly like the previous
// per-route logic did for missing/invalid input.

function parseSafeInt(raw: unknown, fallback: number): number {
  const n = Math.trunc(Number(raw))
  return Number.isSafeInteger(n) ? n : fallback
}

export function parsePagination(
  query: Record<string, unknown>,
  defaultPageSize: number,
  maxPageSize: number,
): { page: number; pageSize: number } {
  const page = Math.max(1, parseSafeInt(query.page, 1))
  const pageSize = Math.min(maxPageSize, Math.max(1, parseSafeInt(query.pageSize, defaultPageSize)))
  return { page, pageSize }
}
