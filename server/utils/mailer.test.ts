import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyDeliveryError } from './outbound-delivery'

const { createTransport } = vi.hoisted(() => ({ createTransport: vi.fn(() => ({ sendMail: vi.fn(async () => ({})) })) }))
vi.mock('nodemailer', () => ({ default: { createTransport } }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('mailer without SMTP configuration', () => {
  it('fails the send outside dev so the outbox retries instead of marking the mail sent', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ smtpUrl: '' }))
    const { sendMail } = await import('./mailer')

    const err = await sendMail({ to: 'lawyer@example.test', subject: 'Test', text: 'Hello' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(classifyDeliveryError(err)).toBe('smtp_not_configured')
  })
})

describe('mailer transport', () => {
  it('bounds SMTP timeouts below the outbox lease unless the URL sets them', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ smtpUrl: 'smtps://user:secret@mail.example.test:465?socketTimeout=5000' }))
    const { sendMail } = await import('./mailer')

    await sendMail({ to: 'lawyer@example.test', subject: 'Test', text: 'Hello' })
    const url = new URL(createTransport.mock.calls[0]![0] as string)
    expect(url.searchParams.get('socketTimeout')).toBe('5000')
    expect(url.searchParams.get('connectionTimeout')).toBe('30000')
    expect(url.searchParams.get('greetingTimeout')).toBe('30000')
    expect(url.password).toBe('secret')
  })
})
