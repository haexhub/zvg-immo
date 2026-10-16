ALTER TABLE "auction_details" ADD COLUMN "is_trial" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "auction_details" ADD COLUMN "llm_provider" text;--> statement-breakpoint
ALTER TABLE "auction_details" ADD COLUMN "llm_model" text;--> statement-breakpoint
ALTER TABLE "auction_details" ADD COLUMN "llm_profile_id" text;--> statement-breakpoint
ALTER TABLE "auction_details" ADD COLUMN "run_trigger" text;--> statement-breakpoint
ALTER TABLE "auction_details" ADD COLUMN "llm_duration_ms" integer;