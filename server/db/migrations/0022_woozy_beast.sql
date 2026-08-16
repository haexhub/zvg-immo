ALTER TABLE "auction_geo_metrics" ADD COLUMN "dist_hiking_m" integer;--> statement-breakpoint
ALTER TABLE "auction_geo_metrics" ADD COLUMN "dist_swimming_m" integer;--> statement-breakpoint
ALTER TABLE "auction_geo_metrics" ADD COLUMN "attraction_density_count" integer;--> statement-breakpoint
-- Existing rows predate the three columns above. Mark them incomplete so the
-- incremental job recomputes them and the detail API keeps WP-8 unavailable
-- until then instead of treating unknown values as poor ones.
UPDATE "auction_geo_metrics" SET "computed_at" = NULL;
