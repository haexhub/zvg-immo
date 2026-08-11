ALTER TABLE "llm_usage_events" ADD COLUMN "status" text DEFAULT 'succeeded' NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD COLUMN "duration_ms" integer;