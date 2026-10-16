// Durable, server-internal mail outbox. Delivery is deliberately at-least-once:
// SMTP may accept a message just before the acknowledgement write fails, so the
// business rows use their own idempotency constraints and the worker never
// promises exactly-once transport.
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const outboundDeliveries = pgTable('outbound_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  dedupeKey: text('dedupe_key').notNull().unique(),
  payload: jsonb('payload').notNull(),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastErrorClass: text('last_error_class'),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_outbound_deliveries_ready').on(table.status, table.nextAttemptAt),
]).enableRLS()
