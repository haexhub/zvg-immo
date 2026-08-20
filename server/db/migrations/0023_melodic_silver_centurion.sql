CREATE TABLE "crawl_state" (
	"country" text NOT NULL,
	"region" text NOT NULL,
	"platform" text NOT NULL,
	"last_success_at" timestamp with time zone NOT NULL,
	"auction_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "crawl_state_country_region_platform_pk" PRIMARY KEY("country","region","platform")
);
--> statement-breakpoint
ALTER TABLE "crawl_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auctions" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auctions" ADD COLUMN "crawl_region" text;--> statement-breakpoint
CREATE INDEX "idx_auctions_crawl_scope" ON "auctions" USING btree ("country","crawl_region","platform");--> statement-breakpoint
-- Backfill last_seen_at from the append-only observation history, which has
-- recorded one row per auction per crawl all along (idx_obs_platform_zvgid_time
-- serves this lookup). crawl_region is deliberately left NULL: the staleness
-- filter is written as NOT EXISTS against crawl_state, so a NULL scope matches
-- no row and hides nothing until that auction's next crawl fills both sides in.
UPDATE "auctions" a SET "last_seen_at" = (
  SELECT MAX(o."captured_at") FROM "auction_observations" o
   WHERE o."platform" = a."platform" AND o."external_id" = a."external_id"
);
