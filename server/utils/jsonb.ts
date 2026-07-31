// PostgreSQL's jsonb/json input rejects an embedded NUL character (code
// point zero) even though it's valid JSON: Postgres' text type is
// C-string-backed and simply cannot store a NUL byte anywhere, so
// json_lex_string throws "unsupported Unicode escape sequence" (detail:
// "cannot be converted to text") for any row containing one, even in an
// unrelated field. Confirmed in prod 2026-07-31: one DE/BW listing with a
// stray NUL (crawler/encoding artifact, never meaningful content) aborted
// list_cache and auction_snapshot upserts that batched dozens of otherwise-
// good rows together.
//
// Stripping the NUL via a replacer (before JSON.stringify escapes anything)
// rather than pattern-matching the already-stringified text: the replacer
// sees each string's real characters, so removing an actual NUL character is
// unambiguous. Post-processing the stringified text is not — a literal
// backslash immediately followed by literal "u0000" text becomes, once
// escaped, indistinguishable from an escaped-NUL sequence that merely starts
// one character later, and a naive substring removal there corrupts the JSON.
const NUL = String.fromCharCode(0)

export function jsonbStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    typeof val === 'string' && val.includes(NUL) ? val.split(NUL).join('') : val)
}
