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

let transporter: Transporter | null | undefined

function getTransporter(): Transporter | null {
  if (transporter !== undefined) return transporter
  const url = useRuntimeConfig().smtpUrl as string | undefined
  transporter = url ? nodemailer.createTransport(url) : null
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
