import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyDeliveryError } from './outbound-delivery'

afterEach(() => vi.unstubAllGlobals())

describe('mailer without SMTP configuration', () => {
  it('fails the send outside dev so the outbox retries instead of marking the mail sent', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ smtpUrl: '' }))
    const { sendMail } = await import('./mailer')

    const err = await sendMail({ to: 'lawyer@example.test', subject: 'Test', text: 'Hello' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(classifyDeliveryError(err)).toBe('smtp_not_configured')
  })
})
