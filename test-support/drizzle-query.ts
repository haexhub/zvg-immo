// Test-only helpers (not imported by app code — kept out of server/utils so
// Nitro's auto-import never picks them up).

/**
 * The SQL text of a `client.query()`/`pool.query()` call. Drizzle passes a
 * `{ text, values, rowMode }` config object where the hand-written pg calls
 * passed a plain string, so every fake pool and SQL assertion in the suite has
 * to accept both shapes.
 */
export function queryText(queryArg: unknown): string {
  return typeof queryArg === 'string' ? queryArg : (queryArg as { text: string }).text
}

/** {@link queryText} for a recorded mock call — `mock.calls.map(callQueryText)`. */
export function callQueryText(call: unknown[]): string {
  return queryText(call[0])
}
