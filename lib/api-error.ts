/** Extract the structured detail emitted by Nitro/createError before falling
 * back to transport-level messages. */
export function apiErrorMessage(error: unknown, fallback: string): string {
  const value = error as {
    data?: { statusMessage?: string; data?: { detail?: string }; message?: string }
    statusMessage?: string
    message?: string
  }
  return value.data?.data?.detail
    || value.data?.statusMessage
    || value.data?.message
    || value.statusMessage
    || value.message
    || fallback
}
