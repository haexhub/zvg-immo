ALTER TABLE "auction_geo_metrics" ADD COLUMN "dist_ski_downhill_m" integer;--> statement-breakpoint
ALTER TABLE "auction_geo_metrics" ADD COLUMN "dist_ski_nordic_m" integer;--> statement-breakpoint
-- Existing rows predate the two columns above. Mark them incomplete so the
-- incremental job recomputes them instead of leaving the new near*
-- search-filter sliders silently unmatched for every already-computed row.
UPDATE "auction_geo_metrics" SET "computed_at" = NULL;