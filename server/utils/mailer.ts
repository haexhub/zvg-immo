// Thin nodemailer wrapper around runtimeConfig.smtpUrl — the app-level
// mailer used by the outbound_deliveries worker (server/utils/outbound-delivery.ts)
// for alert and lawyer-inquiry mail. Distinct from GoTrue's own separate SMTP
// config (docker-compose.yml's `auth` service), which only handles GoTrue's
// own transactional mail. Empty smtpUrl degrades sendMail() to a no-op only in
// local dev; in production it throws so the outbox keeps the row pending and
// eventually 'failed' instead of marking undelivered mail as sent.

import nodemailer, { type Transporter } from 'nodemailer'

export interface MailOptions {
  to: string
  subject: string
  text: string
  replyTo?: string
}

const FROM = 'zvg-immo Alerts <alerts@zvg-immo.local>'

// Well below the outbox's 10-minute processing lease (outbound-delivery.ts):
// nodemailer's 10-minute default socket timeout would let a hung send outlive
// its lease and be reclaimed while still in flight.
const SMTP_TIMEOUTS_MS = { connectionTimeout: 30_000, greetingTimeout: 30_000, socketTimeout: 60_000 }

let transporter: Transporter | null | undefined

function getTransporter(): Transporter | null {
  if (transporter !== undefined) return transporter
  const url = useRuntimeConfig().smtpUrl as string | undefined
  if (!url) return (transporter = null)
  // nodemailer drops object options next to a connection URL, so the
  // timeouts go into its query string; values the operator set there win.
  const smtpUrl = new URL(url)
  for (const [key, ms] of Object.entries(SMTP_TIMEOUTS_MS)) {
    if (!smtpUrl.searchParams.has(key)) smtpUrl.searchParams.set(key, String(ms))
  }
  transporter = nodemailer.createTransport(smtpUrl.toString())
  return transporter
}

export async function sendMail(options: MailOptions): Promise<void> {
  const transport = getTransporter()
  if (!transport) {
    // Message doubles as the outbox error class (classifyDeliveryError).
    if (!import.meta.dev) throw new Error('smtp_not_configured')
    // No recipient/subject in the log: they carry user and lawyer PII.
    console.log('[mailer] NUXT_SMTP_URL not set — dev no-op, mail not sent')
    return
  }
  await transport.sendMail({
    from: FROM,
    to: options.to,
    subject: options.subject,
    text: options.text,
    replyTo: options.replyTo,
  })
}
