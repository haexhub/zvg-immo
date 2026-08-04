// Phase 4: lawyer referral (pay-per-lead). `lawyers` is an admin-maintained
// catalog (server/api/settings/lawyers/*); public reads go through
// server/api/lawyers.get.ts, which filters to active rows, strips `email`,
// and connects as table owner (bypasses RLS) — hence no policies here.
import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

export const lawyers = pgTable('lawyers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  firm: text('firm'),
  email: text('email').notNull(),
  phone: text('phone'),
  // Lowercase ISO-2 codes matching Auction.country (types/auction.ts).
  countries: text('countries').array().notNull(),
  specialization: text('specialization'),
  languages: text('languages').array(),
  website: text('website'),
  commissionCents: integer('commission_cents'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_lawyers_countries').using('gin', table.countries),
]).enableRLS()

// One row per inquiry a logged-in user sends to a lawyer
// (server/api/lawyer-inquiries/index.post.ts) — the billing record for that
// lawyer's commission. lawyerId is ON DELETE RESTRICT: a lawyer with
// existing inquiries can only be deactivated, not deleted.
export const lawyerInquiries = pgTable('lawyer_inquiries', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  lawyerId: uuid('lawyer_id').notNull().references(() => lawyers.id, { onDelete: 'restrict' }),
  platform: text('platform'),
  externalId: text('external_id'),
  message: text('message').notNull(),
  commissionCents: integer('commission_cents'),
  commissionStatus: text('commission_status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_inquiries_lawyer_time').on(table.lawyerId, table.createdAt.desc()),
  index('idx_inquiries_user_time').on(table.userId, table.createdAt.desc()),
  pgPolicy('own_rows', {
    for: 'all',
    using: sql`${table.userId} = auth.uid()`,
    withCheck: sql`${table.userId} = auth.uid()`,
  }),
]).enableRLS()
