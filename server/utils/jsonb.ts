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
// Stripping it from the stringified text (rather than walking the object) is
// safe: JSON.stringify only ever emits one specific six-character escape
// sequence for an embedded NUL character; a literal backslash in the source
// data is itself escaped, so that sequence can't mean anything else.
// Built from character codes, not a string literal, so this source file
// never contains the escape sequence (or a real NUL byte) directly.
const JSON_ESCAPED_NUL = String.fromCharCode(92, 117, 48, 48, 48, 48)

export function jsonbStringify(value: unknown): string {
  return JSON.stringify(value).split(JSON_ESCAPED_NUL).join('')
}
