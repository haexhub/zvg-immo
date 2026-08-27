/**
 * Log implementation details server-side while keeping public API errors
 * stable and safe to return to unauthenticated clients.
 */
export function publicError(context: string, statusCode: number, message: string, cause: unknown) {
  console.error(`[${context}]`, cause)
  return createError({ statusCode, message })
}
