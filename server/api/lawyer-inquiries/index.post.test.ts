import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getServiceClient, readAuctionRecord, createLawyerInquiryWithDelivery, canonicalAppOrigin } = vi.hoisted(() => ({
  getServiceClient: vi.fn(),
  readAuctionRecord: vi.fn(),
  createLawyerInquiryWithDelivery: vi.fn(),
  canonicalAppOrigin: vi.fn(),
}))

vi.mock('../../utils/supabase', () => ({ getServiceClient }))
vi.mock('../../utils/auction-record', () => ({ readAuctionRecord }))
vi.mock('../../utils/outbound-delivery', async () => {
  const actual = await vi.importActual<typeof import('../../utils/outbound-delivery')>('../../utils/outbound-delivery')
  return { ...actual, createLawyerInquiryWithDelivery, canonicalAppOrigin }
})

vi.stubGlobal('defineEventHandler', <T>(handler: T) => handler)
vi.stubGlobal('readBody', async (event: { body?: unknown }) => event.body)
vi.stubGlobal('getRequestHeader', (event: { headers?: Record<string, string> }, key: string) => event.headers?.[key])
vi.stubGlobal('createError', (input: { statusCode: number, statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

const key = '88a2d4ea-cda7-4384-9a0e-443811f33a7d'

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    body: { lawyerId: 'lawyer-1', platform: 'portal', externalId: '42', message: 'Bitte melden Sie sich.' },
    headers: { 'idempotency-key': key, host: 'attacker.example' },
    context: { user: { id: 'user-1', email: 'buyer@example.test' } },
    ...overrides,
  }
}

function lawyerClient(active = true) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({
          data: { id: 'lawyer-1', email: 'lawyer@example.test', active, countries: ['de'], commission_cents: 12900 }, error: null,
        })) })),
      })),
    })),
  }
}

async function loadHandler() {
  vi.resetModules()
  return (await import('./index.post')).default as unknown as (event: Record<string, unknown>) => Promise<unknown>
}

beforeEach(() => {
  getServiceClient.mockReturnValue(lawyerClient())
  readAuctionRecord.mockResolvedValue({ auction: { country: 'de', authority: 'AG Test', caseNumber: '1 K 2/26' } })
  canonicalAppOrigin.mockReturnValue('https://zvg.example.test')
  createLawyerInquiryWithDelivery.mockResolvedValue({
    id: 'inquiry-1', lawyerId: 'lawyer-1', platform: 'portal', externalId: '42', message: 'Bitte melden Sie sich.',
    commissionCents: 12900, commissionStatus: 'pending', deliveryStatus: 'pending', createdAt: '2026-08-09T10:00:00.000Z',
  })
})

afterEach(() => vi.clearAllMocks())

describe('POST /api/lawyer-inquiries', () => {
  it('requires a stable idempotency key before creating a billable lead', async () => {
    const handler = await loadHandler()
    await expect(handler(makeEvent({ headers: {} }))).rejects.toMatchObject({ statusCode: 400 })
    expect(createLawyerInquiryWithDelivery).not.toHaveBeenCalled()
  })

  it('rejects oversize messages before persistence', async () => {
    const handler = await loadHandler()
    await expect(handler(makeEvent({ body: { lawyerId: 'lawyer-1', platform: 'portal', externalId: '42', message: 'x'.repeat(4001) } }))).rejects.toMatchObject({ statusCode: 413 })
    expect(createLawyerInquiryWithDelivery).not.toHaveBeenCalled()
  })

  it('rejects inactive lawyers before enqueueing', async () => {
    getServiceClient.mockReturnValue(lawyerClient(false))
    const handler = await loadHandler()
    await expect(handler(makeEvent())).rejects.toMatchObject({ statusCode: 404 })
    expect(createLawyerInquiryWithDelivery).not.toHaveBeenCalled()
  })

  it('uses the configured canonical origin, never the hostile request host', async () => {
    const handler = await loadHandler()
    await handler(makeEvent())
    expect(createLawyerInquiryWithDelivery).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: key,
      mail: expect.objectContaining({ text: expect.stringContaining('https://zvg.example.test/objekt/portal/42') }),
    }))
    expect(createLawyerInquiryWithDelivery).toHaveBeenCalledWith(expect.objectContaining({
      mail: expect.objectContaining({ text: expect.not.stringContaining('attacker.example') }),
    }))
  })
})
