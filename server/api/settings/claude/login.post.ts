import { callProxySetup } from '../../../utils/claude-proxy'

export default defineEventHandler(async () => {
  return callProxySetup<{ oauthUrl: string }>('POST', '/login')
})
