-- Custom SQL migration file, put your code below! --

-- auth.users is GoTrue's table, not ours (created by GoTrue's own
-- migrations, not by anything in server/db/schema/*.ts) — a Drizzle
-- `.references()` on that schema would make `drizzle-kit generate` try to
-- emit `CREATE TABLE "auth"."users"`, which already exists and would break.
-- These five FKs mirror schema.sql's `REFERENCES auth.users(id) ON DELETE
-- CASCADE` for every user-owned table (see server/db/schema/access.ts,
-- server/db/schema/lawyers.ts). docker-compose.yml's `app` service depends
-- on `auth: { condition: service_healthy }` so auth.users exists before this
-- migration ever runs.
ALTER TABLE "saved_searches" ADD CONSTRAINT "fk_saved_searches_user" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_items" ADD CONSTRAINT "fk_watchlist_items_user" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_subscriptions" ADD CONSTRAINT "fk_alert_subscriptions_user" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "fk_api_keys_user" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lawyer_inquiries" ADD CONSTRAINT "fk_lawyer_inquiries_user" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- auction_fetch_state.llm_artifact_version_id: a 3-column composite FK where
-- only the first column should be nulled on delete (platform/external_id
-- stay NOT NULL and must never be nulled) — Postgres 15+'s
-- `ON DELETE SET NULL (column)` syntax expresses this, but Drizzle's
-- foreignKey() builder has no equivalent, so it isn't declared in
-- server/db/schema/core.ts at all (see the comment on auctionFetchState).
-- Matches schema.sql's fk_auction_fetch_state_llm_artifact.
ALTER TABLE "auction_fetch_state" ADD CONSTRAINT "fk_auction_fetch_state_llm_artifact" FOREIGN KEY ("llm_artifact_version_id", "platform", "external_id") REFERENCES "public"."artifact_versions"("id", "platform", "external_id") ON DELETE SET NULL ("llm_artifact_version_id") ON UPDATE no action;
