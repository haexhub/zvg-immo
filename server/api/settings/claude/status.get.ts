import { callProxySetup } from '../../../utils/claude-proxy'

export interface ClaudeAccountInfo {
  organizationUuid: string | null
  subscriptionType: string | null
  emailAddress: string | null
}

export interface ClaudeSetupStatus {
  state: 'idle' | 'awaiting-url' | 'awaiting-code' | 'finishing' | 'done' | 'error'
  oauthUrl: string | null
  errorMessage: string | null
  startedAt: string | null
  credentialsExist?: boolean
  accountInfo?: ClaudeAccountInfo | null
}

export default defineEventHandler(async () => {
  return callProxySetup<ClaudeSetupStatus>('GET', '/status')
})
