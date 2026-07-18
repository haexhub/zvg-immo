// Thin nodemailer wrapper around runtimeConfig.smtpUrl — the app-level
// mailer for alert emails (server/utils/alert-matching.ts). Distinct from
// GoTrue's own separate SMTP config (docker-compose.yml's `auth` service),
// which only handles GoTrue's own transactional mail. Empty smtpUrl (local
// dev without SMTP) degrades sendMail() to a no-op with a log line instead
// of throwing — same graceful-degrade pattern as extractLlm.baseUrl.

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
    console.log(`[mailer] NUXT_SMTP_URL not set — would send "${options.subject}" to ${options.to}`)
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
