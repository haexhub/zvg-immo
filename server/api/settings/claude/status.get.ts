import { callProxySetup } from '../../../utils/claude-proxy'

export interface ClaudeSetupStatus {
  state: 'idle' | 'awaiting-url' | 'awaiting-code' | 'finishing' | 'done' | 'error'
  oauthUrl: string | null
  errorMessage: string | null
  startedAt: string | null
  credentialsExist?: boolean
}

export default defineEventHandler(async () => {
  return callProxySetup<ClaudeSetupStatus>('GET', '/status')
})
