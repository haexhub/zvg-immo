ALTER TABLE "auctions" ADD COLUMN "geocode_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auctions" ADD COLUMN "geocode_result" text;--> statement-breakpoint
ALTER TABLE "auctions" ADD COLUMN "geocode_provider" text;