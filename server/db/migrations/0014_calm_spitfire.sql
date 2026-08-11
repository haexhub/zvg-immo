CREATE TABLE "llm_usage_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"task" text NOT NULL,
	"execution_mode" text NOT NULL,
	"source" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"profile_id" text,
	"platform" text,
	"external_id" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" double precision
);
--> statement-breakpoint
ALTER TABLE "llm_usage_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "llm_batch_jobs" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "llm_batch_jobs" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "llm_batch_jobs" ADD COLUMN "profile_id" text;--> statement-breakpoint
CREATE INDEX "idx_llm_usage_events_occurred_at" ON "llm_usage_events" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_llm_usage_events_task_occurred" ON "llm_usage_events" USING btree ("task","occurred_at" DESC NULLS LAST);