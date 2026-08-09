// Sends a contact request to a lawyer on behalf of the logged-in user.
// server/middleware/supabase-auth.ts has already verified event.context.user
// and 401'd otherwise (via the /api/lawyer-inquiries/ prefix added there).
//
// Relay-only, no direct contact: the lawyer's email is never exposed to the
// client (see server/api/lawyers.get.ts) — this route is the only path that
// reaches it, and only server-side, via server/utils/mailer.ts. That's also
// A successful response means the commission-bearing inquiry and its mail
// intent were atomically persisted. It deliberately does not claim that SMTP
// has completed: server/tasks/outbound-delivery.ts retries that at-least-once
// transport independently.

import { getServiceClient } from '../../utils/supabase'
import { readAuctionRecord } from '../../utils/auction-record'
import {
  canonicalAppOrigin,
  createLawyerInquiryWithDelivery,
  LawyerInquiryRateLimitError,
  MAX_LAWYER_INQUIRY_MESSAGE_LENGTH,
  validateIdempotencyKey,
} from '../../utils/outbound-delivery'

export interface LawyerInquiry {
  id: string
  lawyerId: string
  platform: string | null
  externalId: string | null
  message: string
  commissionCents: number | null
  commissionStatus: string
  deliveryStatus: string
  createdAt: string
}

export default defineEventHandler(async (event): Promise<LawyerInquiry> => {
  const body = await readBody<{
    lawyerId?: unknown
    platform?: unknown
    externalId?: unknown
    message?: unknown
  }>(event).catch(() => undefined) ?? ({} as Record<string, unknown>)
  const lawyerId = typeof body.lawyerId === 'string' ? body.lawyerId.trim() : ''
  const platform = typeof body.platform === 'string' ? body.platform.trim() : ''
  const externalId = typeof body.externalId === 'string' ? body.externalId.trim() : ''
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!lawyerId || !platform || !externalId || !message) {
    throw createError({ statusCode: 400, statusMessage: 'lawyerId, platform, externalId und message sind erforderlich.' })
  }
  if (message.length > MAX_LAWYER_INQUIRY_MESSAGE_LENGTH) {
    throw createError({ statusCode: 413, statusMessage: `Die Nachricht darf höchstens ${MAX_LAWYER_INQUIRY_MESSAGE_LENGTH} Zeichen enthalten.` })
  }
  const idempotencyKey = getRequestHeader(event, 'idempotency-key')?.trim() ?? ''
  if (!validateIdempotencyKey(idempotencyKey)) {
    throw createError({ statusCode: 400, statusMessage: 'Ein gültiger Idempotency-Key ist erforderlich.' })
  }

  const record = await readAuctionRecord(platform, externalId)
  if (!record) {
    throw createError({ statusCode: 404, statusMessage: 'Auktion nicht gefunden.' })
  }
  const auction = record.auction

  const supabase = getServiceClient()
  if (!supabase) {
    throw createError({ statusCode: 503, statusMessage: 'Supabase ist nicht konfiguriert.' })
  }

  const { data: lawyer, error: lawyerError } = await supabase
    .from('lawyers')
    .select('id, email, name, active, countries, commission_cents')
    .eq('id', lawyerId)
    .maybeSingle()
  if (lawyerError) {
    throw createError({ statusCode: 500, statusMessage: lawyerError.message })
  }
  if (!lawyer || !lawyer.active) {
    throw createError({ statusCode: 404, statusMessage: 'Anwalt nicht gefunden oder nicht aktiv.' })
  }
  const countries = (lawyer.countries as string[] | null) ?? []
  if (!countries.includes(auction.country)) {
    throw createError({ statusCode: 400, statusMessage: 'Dieser Anwalt deckt das Land der Auktion nicht ab.' })
  }

  const userId = event.context.user!.id
  const userEmail = event.context.user!.email ?? undefined
  // Snapshot the commission now — later tariff changes to lawyers.commission_cents
  // must not rewrite this historical billing record.
  const commissionCents = (lawyer.commission_cents as number | null) ?? null

  const auctionLabel = `${auction.authority} · ${auction.caseNumber}`
  let origin: string
  try {
    origin = canonicalAppOrigin()
  } catch (err) {
    throw createError({ statusCode: 503, statusMessage: (err as Error).message })
  }
  const auctionLink = `${origin}/objekt/${encodeURIComponent(platform)}/${encodeURIComponent(externalId)}`
  try {
    const inserted = await createLawyerInquiryWithDelivery({
      userId,
      lawyerId,
      platform,
      externalId,
      message,
      commissionCents,
      idempotencyKey,
      mail: {
        to: lawyer.email as string,
        replyTo: userEmail,
        subject: `Neue Anfrage über zvg-immo: ${auctionLabel}`,
        text: [
        `Sie haben über zvg-immo eine Anfrage zu folgender Zwangsversteigerung erhalten:`,
        auctionLabel,
        auctionLink,
        '',
        'Nachricht:',
        message,
        '',
        userEmail ? `Antworten Sie direkt auf diese E-Mail, um ${userEmail} zu erreichen.` : '',
      ].filter(Boolean).join('\n'),
      },
    })
    return {
      id: inserted.id,
      lawyerId: inserted.lawyerId,
      platform: inserted.platform,
      externalId: inserted.externalId,
      message: inserted.message,
      commissionCents: inserted.commissionCents,
      commissionStatus: inserted.commissionStatus,
      deliveryStatus: inserted.deliveryStatus,
      createdAt: inserted.createdAt,
    }
  } catch (err) {
    if (err instanceof LawyerInquiryRateLimitError) {
      throw createError({ statusCode: 429, statusMessage: err.message })
    }
    throw createError({ statusCode: 500, statusMessage: `Anfrage konnte nicht gespeichert werden: ${(err as Error).message}` })
  }
})
