import type { Pool, PoolClient } from 'pg'
import { getPool } from './db'
import { sendMail } from './mailer'

export const MAX_LAWYER_INQUIRY_MESSAGE_LENGTH = 4_000
export const MAX_LAWYER_INQUIRIES_PER_HOUR = 5
const MAX_DELIVERY_ATTEMPTS = 6
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000

export type DeliveryStatus = 'pending' | 'processing' | 'sent' | 'failed'

interface MailPayload {
  to: string
  subject: string
  text: string
  replyTo?: string
}

interface AlertPayload extends MailPayload {
  alertSubscriptionId: string
  platform: string
  externalId: string
}

interface LawyerInquiryPayload extends MailPayload {
  inquiryId: string
}

type DeliveryPayload = AlertPayload | LawyerInquiryPayload

interface ClaimedDelivery {
  id: string
  kind: 'alert' | 'lawyer_inquiry'
  payload: DeliveryPayload
  attempts: number
}

export class LawyerInquiryRateLimitError extends Error {}

export function validateIdempotencyKey(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export function deliveryRetryAt(attempt: number, now = new Date()): Date {
  const delay = Math.min(60_000 * 2 ** Math.max(0, attempt - 1), MAX_RETRY_DELAY_MS)
  return new Date(now.getTime() + delay)
}

/** A short, non-secret operational class. The full SMTP error is never stored. */
export function classifyDeliveryError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const smtp = /\b([45]\d\d)\b/.exec(message)
  if (smtp) return `smtp_${smtp[1]}`
  if (/timeout|timed out|etimedout/i.test(message)) return 'timeout'
  if (/econn|network|socket/i.test(message)) return 'network'
  return 'unknown'
}

export function canonicalAppOrigin(): string {
  const configured = useRuntimeConfig().appOrigin as string | undefined
  try {
    const url = new URL(configured ?? '')
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('unsupported protocol')
    return url.origin
  } catch {
    throw new Error('NUXT_APP_ORIGIN muss eine absolute http(s)-URL sein')
  }
}

export async function enqueueAlertDelivery(payload: AlertPayload): Promise<boolean> {
  const db = getPool()
  if (!db) return false
  const dedupeKey = `alert:${payload.alertSubscriptionId}:${payload.platform}:${payload.externalId}`
  await db.query(
    `INSERT INTO outbound_deliveries (kind, dedupe_key, payload)
     VALUES ('alert', $1, $2::jsonb)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [dedupeKey, JSON.stringify(payload)],
  )
  return true
}

export interface NewLawyerInquiry {
  userId: string
  lawyerId: string
  platform: string
  externalId: string
  message: string
  commissionCents: number | null
  idempotencyKey: string
  mail: Omit<LawyerInquiryPayload, 'inquiryId'>
}

export interface StoredLawyerInquiry {
  id: string
  lawyerId: string
  platform: string | null
  externalId: string | null
  message: string
  commissionCents: number | null
  commissionStatus: string
  deliveryStatus: DeliveryStatus
  createdAt: string
}

function rowToInquiry(row: Record<string, unknown>): StoredLawyerInquiry {
  return {
    id: String(row.id),
    lawyerId: String(row.lawyer_id),
    platform: row.platform as string | null,
    externalId: row.external_id as string | null,
    message: String(row.message),
    commissionCents: row.commission_cents as number | null,
    commissionStatus: String(row.commission_status),
    deliveryStatus: row.delivery_status as DeliveryStatus,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }
}

export async function createLawyerInquiryWithDelivery(input: NewLawyerInquiry): Promise<StoredLawyerInquiry> {
  const db = getPool()
  if (!db) throw new Error('Datenbank ist nicht konfiguriert.')
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const existing = await client.query(
      `SELECT id, lawyer_id, platform, external_id, message, commission_cents, commission_status, delivery_status, created_at
       FROM lawyer_inquiries WHERE user_id = $1 AND idempotency_key = $2`,
      [input.userId, input.idempotencyKey],
    )
    if (existing.rows[0]) {
      await client.query('COMMIT')
      return rowToInquiry(existing.rows[0])
    }

    // Serialise a user's requests to one lawyer so the rate-limit count and
    // insertion form one decision even across concurrent HTTP requests.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${input.userId}:${input.lawyerId}`])
    // A same-key request may have arrived while this request waited on the
    // rate-limit lock. Re-check before counting/inserting so concurrent
    // retries converge on the original billable row instead of its unique
    // constraint becoming a 500 response.
    const concurrentExisting = await client.query(
      `SELECT id, lawyer_id, platform, external_id, message, commission_cents, commission_status, delivery_status, created_at
       FROM lawyer_inquiries WHERE user_id = $1 AND idempotency_key = $2`,
      [input.userId, input.idempotencyKey],
    )
    if (concurrentExisting.rows[0]) {
      await client.query('COMMIT')
      return rowToInquiry(concurrentExisting.rows[0])
    }
    const recent = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM lawyer_inquiries
       WHERE user_id = $1 AND lawyer_id = $2 AND created_at >= now() - interval '1 hour'`,
      [input.userId, input.lawyerId],
    )
    if (Number(recent.rows[0]?.count ?? 0) >= MAX_LAWYER_INQUIRIES_PER_HOUR) {
      throw new LawyerInquiryRateLimitError('Zu viele Anfragen an diesen Anwalt. Bitte versuchen Sie es später erneut.')
    }

    const inserted = await client.query(
      `INSERT INTO lawyer_inquiries
        (user_id, lawyer_id, platform, external_id, message, idempotency_key, commission_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, lawyer_id, platform, external_id, message, commission_cents, commission_status, delivery_status, created_at`,
      [input.userId, input.lawyerId, input.platform, input.externalId, input.message, input.idempotencyKey, input.commissionCents],
    )
    const row = inserted.rows[0]
    if (!row) throw new Error('Anfrage konnte nicht gespeichert werden.')
    const inquiry = rowToInquiry(row)
    await client.query(
      `INSERT INTO outbound_deliveries (kind, dedupe_key, payload)
       VALUES ('lawyer_inquiry', $1, $2::jsonb)`,
      [`lawyer-inquiry:${inquiry.id}`, JSON.stringify({ ...input.mail, inquiryId: inquiry.id })],
    )
    await client.query('COMMIT')
    return inquiry
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function claimNextDelivery(db: Pool): Promise<ClaimedDelivery | null> {
  const { rows } = await db.query<ClaimedDelivery>(
    `WITH candidate AS (
       SELECT id FROM outbound_deliveries
       WHERE (status = 'pending' AND next_attempt_at <= now())
          OR (status = 'processing' AND locked_at < now() - interval '10 minutes')
       ORDER BY next_attempt_at, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE outbound_deliveries AS d
     SET status = 'processing', locked_at = now(), attempts = d.attempts + 1
     FROM candidate
     WHERE d.id = candidate.id
     RETURNING d.id, d.kind, d.payload, d.attempts`,
  )
  const row = rows[0]
  if (!row || (row.kind !== 'alert' && row.kind !== 'lawyer_inquiry') || !row.payload) return null
  return row
}

async function markDeliverySent(db: Pool, delivery: ClaimedDelivery): Promise<void> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE outbound_deliveries SET status = 'sent', sent_at = now(), locked_at = NULL, last_error_class = NULL
       WHERE id = $1`,
      [delivery.id],
    )
    if (delivery.kind === 'alert') {
      const payload = delivery.payload as AlertPayload
      await client.query(
        `INSERT INTO notified_matches (alert_subscription_id, platform, external_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (alert_subscription_id, platform, external_id) DO NOTHING`,
        [payload.alertSubscriptionId, payload.platform, payload.externalId],
      )
    } else {
      await client.query(
        `UPDATE lawyer_inquiries SET delivery_status = 'sent' WHERE id = $1`,
        [(delivery.payload as LawyerInquiryPayload).inquiryId],
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function markDeliveryFailure(db: Pool, delivery: ClaimedDelivery, err: unknown): Promise<void> {
  const terminal = delivery.attempts >= MAX_DELIVERY_ATTEMPTS
  const status: DeliveryStatus = terminal ? 'failed' : 'pending'
  await db.query(
    `UPDATE outbound_deliveries
     SET status = $2, locked_at = NULL, last_error_class = $3,
         next_attempt_at = CASE WHEN $2 = 'pending' THEN $4 ELSE next_attempt_at END
     WHERE id = $1`,
    [delivery.id, status, classifyDeliveryError(err), deliveryRetryAt(delivery.attempts)],
  )
  if (delivery.kind === 'lawyer_inquiry' && terminal) {
    await db.query(`UPDATE lawyer_inquiries SET delivery_status = 'failed' WHERE id = $1`, [
      (delivery.payload as LawyerInquiryPayload).inquiryId,
    ])
  }
}

/** Drains a small, lock-safe batch. A crash after SMTP acknowledgement may
 * retry one message; this is intentionally at-least-once rather than falsely
 * claiming exactly-once delivery. */
export async function drainOutboundDeliveries(limit = 20): Promise<{ sent: number; failed: number }> {
  const db = getPool()
  if (!db) return { sent: 0, failed: 0 }
  let sent = 0
  let failed = 0
  for (let i = 0; i < limit; i++) {
    const delivery = await claimNextDelivery(db)
    if (!delivery) break
    try {
      const payload = delivery.payload as MailPayload
      await sendMail(payload)
      await markDeliverySent(db, delivery)
      sent++
    } catch (err) {
      await markDeliveryFailure(db, delivery, err)
      failed++
      console.warn(`[outbound-delivery] ${delivery.kind}/${delivery.id} failed: ${classifyDeliveryError(err)}`)
    }
  }
  return { sent, failed }
}

export interface OutboundDeliveryOverview {
  pending: number
  processing: number
  failed: number
  recentFailures: Array<{ kind: string; attempts: number; lastErrorClass: string | null; createdAt: string }>
}

/** Small, secret-free settings projection. Payloads are deliberately never
 * exposed: they can contain a user's contact text and email addresses. */
export async function getOutboundDeliveryOverview(): Promise<OutboundDeliveryOverview> {
  const db = getPool()
  if (!db) return { pending: 0, processing: 0, failed: 0, recentFailures: [] }
  const [counts, failures] = await Promise.all([
    db.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM outbound_deliveries
       WHERE status IN ('pending', 'processing', 'failed') GROUP BY status`,
    ),
    db.query<{ kind: string; attempts: number; last_error_class: string | null; created_at: Date | string }>(
      `SELECT kind, attempts, last_error_class, created_at FROM outbound_deliveries
       WHERE status = 'failed' ORDER BY created_at DESC LIMIT 20`,
    ),
  ])
  const byStatus = new Map(counts.rows.map((row) => [row.status, Number(row.count)]))
  return {
    pending: byStatus.get('pending') ?? 0,
    processing: byStatus.get('processing') ?? 0,
    failed: byStatus.get('failed') ?? 0,
    recentFailures: failures.rows.map((row) => ({
      kind: row.kind,
      attempts: row.attempts,
      lastErrorClass: row.last_error_class,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    })),
  }
}
