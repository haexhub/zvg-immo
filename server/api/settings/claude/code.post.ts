import { callProxySetup } from '../../../utils/claude-proxy'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ code?: unknown }>(event).catch(
    () => undefined,
  ) ?? ({} as { code?: unknown })
  const code = typeof body.code === 'string' ? body.code.trim() : ''
  if (!code) {
    throw createError({ statusCode: 400, statusMessage: 'Code fehlt.' })
  }
  return callProxySetup<{ ok: true }>('POST', '/code', { code })
})
