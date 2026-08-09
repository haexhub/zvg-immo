# Plan 003: Make outbound notifications durable and abuse-resistant

> **Executor instructions**: This changes user communication and commission
> records. Make delivery state explicit; do not claim exactly-once delivery
> without a durable idempotency design.
>
> **Drift check (run first)**: `git diff --stat abceeb9..HEAD -- server/utils/alert-matching.ts server/api/lawyer-inquiries server/db/schema/lawyers.ts server/utils/mailer.ts server/db/migrations`

## Status

- **Implementation**: DONE, 2026-08-09
- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/001-patch-dependencies-and-error-boundaries.md`
- **Category**: bug, security, tests, migration
- **Planned at**: commit `abceeb9`, 2026-08-09
- **Completed by**: commit `dff7436` (`Make outbound notifications durable`, PR #389)

## Completion record

Implemented and merged in PR #389: a private, at-least-once delivery outbox
with a scheduled/boot-safe worker; transactionally idempotent lawyer inquiries;
message and rate bounds; server-only canonical mail origins; and settings
visibility for terminal delivery failures. The plan's remaining text is kept as
the implementation record.

## Why this matters

Alerts are marked sent before email delivery, permanently suppressing retries
after SMTP or user-directory failures. Lawyer inquiries persist a commission-
bearing lead before mailing but return 502 on delivery failure; a user retry can
therefore create duplicate leads, emails and later invoices. The authenticated
relay also lacks message-size and delivery-rate bounds, and builds email links
from the request origin.

## Current state

- `server/utils/alert-matching.ts:145-169` inserts `notified_matches` before
  resolving the recipient and before `sendMail`.
- `server/api/lawyer-inquiries/index.post.ts:38-41,76-112` accepts unbounded
  nonempty message text, inserts the inquiry, derives a request-origin link at
  `:93-94`, then throws after mail failure.
- `server/db/schema/lawyers.ts` has neither delivery state nor a request
  idempotency constraint for inquiries. Existing database style is Drizzle
  schema plus numbered SQL migrations in `server/db/migrations/`.
- `server/utils/mailer.ts` is the one transport abstraction; preserve its
  no-SMTP development behaviour.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Migration tests | `pnpm test -- server/utils/alert-matching.test.ts server/api/lawyer-inquiries` | exit 0 |
| Full tests | `pnpm test` | exit 0 |
| Typecheck | `pnpm exec nuxi typecheck` | exit 0 |
| Build | `pnpm build` | exit 0 |

## Scope

**In scope**: alert matching, lawyer inquiry route/schema/migration, mailer
adapter, an outbox/task module, canonical server-only app-origin configuration,
and exact route/unit tests.

**Out of scope**: billing provider integration, changing commission prices,
marketing email templates, and frontend redesign.

## Steps

### Step 1: Lock desired semantics in tests

Test alert recipient lookup failure, SMTP failure and later retry. Test lawyer
inquiry duplicate submissions, an ambiguous mail timeout, inactive lawyers,
oversize text and rate-limit responses. Model mocks on existing Supabase and
mailer route tests; add direct tests because current alert tests only cover
filter parsing.

**Verify**: all new failure-state tests fail against current behaviour where
appropriate and never send real mail.

### Step 2: Add durable delivery and idempotency state

Add a forward-only Drizzle migration and schema fields/tables for a delivery
outbox and stable idempotency identity. For alerts, atomically claim pending
matches and mark sent only after a successful mail acknowledgement. For lawyer
inquiries, accept a client idempotency key (or a safe server-derived short
window only if product approves its collision semantics), persist one lead and
enqueue one delivery. Store attempts, last error class and retry time without
storing secret values.

**Verify**: migration generation/application succeeds in a disposable DB and
tests prove a retry does not duplicate billable inquiry rows.

### Step 3: Deliver with retry and bounded abuse controls

Implement a scheduled/boot-safe worker following existing task conventions.
Use bounded exponential retry and a terminal failed state visible to settings.
Set a maximum message length plus per-user/per-lawyer rate limits before
enqueueing. Return a stable accepted/pending result rather than falsely
reporting permanent failure after persistence.

**Verify**: simulated SMTP failure remains pending then reaches sent once;
rate-limited requests produce 429 and no new mail/outbox row.

### Step 4: Use a canonical origin

Add a server-only runtime config setting for the app's canonical origin, parse
it as a URL, and use it for all outbound links. Do not use `getRequestURL`
for email links. Match the existing public base URL documentation in
`nuxt.config.ts` but do not expose the setting to clients unnecessarily.

**Verify**: a route test with a hostile request host proves the mailed URL uses
the configured canonical origin.

## Done criteria

- [x] No notification becomes permanently sent before durable transport success.
- [x] Repeating an inquiry cannot duplicate a commission-bearing lead.
- [x] Relay message size and rate limits are enforced server-side.
- [x] Outbound links are configuration-derived, never request-host-derived.
- [x] Full lint/typecheck/test/build gates pass.

## STOP conditions

- Stop if product owners cannot choose duplicate-submission semantics.
- Stop if migration requires rewriting existing commission history; propose a
  forward-only backfill instead.

## Maintenance notes

Treat mail delivery as at-least-once transport with idempotent business writes.
Review the worker's locking and visibility of terminal failures carefully.
