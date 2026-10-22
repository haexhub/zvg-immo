ALTER TABLE "auction_fetch_state" ADD COLUMN "detail_source_updated_iso" timestamp with time zone;--> statement-breakpoint
-- A detail fetched after the last upstream update has seen that state. Rows
-- updated upstream after their detail fetch stay NULL, so the next enrich
-- run fetches their detail page again.
UPDATE "auction_fetch_state" SET "detail_source_updated_iso" = "source_updated_iso"
WHERE "detail_fetched_at" IS NOT NULL AND "source_updated_iso" IS NOT NULL
  AND "source_updated_iso" <= "detail_fetched_at";
