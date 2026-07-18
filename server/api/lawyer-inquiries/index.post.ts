// Sends a contact request to a lawyer on behalf of the logged-in user.
// server/middleware/supabase-auth.ts has already verified event.context.user
// and 401'd otherwise (via the /api/lawyer-inquiries/ prefix added there).
//
// Relay-only, no direct contact: the lawyer's email is never exposed to the
// client (see server/api/lawyers.get.ts) — this route is the only path that
// reaches it, and only server-side, via server/utils/mailer.ts. That's also
// why a failed send is a hard error (502) here, unlike the alert matcher's
// best-effort mail (server/utils/alert-matching.ts): the whole point of this
// action is that the mail arrives, so a swallowed failure would leave the
// user believing they'd contacted the lawyer when they hadn't.

import { getServiceClient } from '../../utils/supabase'
import { sendMail } from '../../utils/mailer'
import { readAuctionSnapshot } from '../../utils/auction-snapshot'
import { cacheKey } from '../../utils/verkehrswert-cache'

export interface LawyerInquiry {
  id: string
  lawyerId: string
  platform: string | null
  externalId: string | null
  message: string
  commissionCents: number | null
  commissionStatus: string
  createdAt: string
}

export default defineEventHandler(async (event): Promise<LawyerInquiry> => {
  const body = await readBody<{
    lawyerId?: unknown
    platform?: unknown
    externalId?: unknown
    message?: unknown
  }>(event).catch(() => ({}) as Record<string, unknown>)
  const lawyerId = typeof body.lawyerId === 'string' ? body.lawyerId.trim() : ''
  const platform = typeof body.platform === 'string' ? body.platform.trim() : ''
  const externalId = typeof body.externalId === 'string' ? body.externalId.trim() : ''
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!lawyerId || !platform || !externalId || !message) {
    throw createError({ statusCode: 400, statusMessage: 'lawyerId, platform, externalId und message sind erforderlich.' })
  }

  const snapshot = await readAuctionSnapshot()
  const auction = snapshot[cacheKey(platform, externalId)]
  if (!auction) {
    throw createError({ statusCode: 404, statusMessage: 'Auktion nicht gefunden.' })
  }

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

  const { data: inserted, error: insertError } = await supabase
    .from('lawyer_inquiries')
    .insert({
      user_id: userId,
      lawyer_id: lawyerId,
      platform,
      external_id: externalId,
      message,
      commission_cents: commissionCents,
    })
    .select('id, lawyer_id, platform, external_id, message, commission_cents, commission_status, created_at')
    .single()
  if (insertError || !inserted) {
    throw createError({ statusCode: 500, statusMessage: insertError?.message ?? 'Anfrage konnte nicht gespeichert werden.' })
  }

  const auctionLabel = `${auction.authority} · ${auction.caseNumber}`
  const origin = getRequestURL(event).origin
  const auctionLink = `${origin}/objekt/${encodeURIComponent(platform)}/${encodeURIComponent(externalId)}`
  try {
    await sendMail({
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
    })
  } catch (err) {
    throw createError({ statusCode: 502, statusMessage: `Mail-Versand fehlgeschlagen: ${(err as Error).message}` })
  }

  return {
    id: inserted.id as string,
    lawyerId: inserted.lawyer_id as string,
    platform: inserted.platform as string | null,
    externalId: inserted.external_id as string | null,
    message: inserted.message as string,
    commissionCents: inserted.commission_cents as number | null,
    commissionStatus: inserted.commission_status as string,
    createdAt: inserted.created_at as string,
  }
})
