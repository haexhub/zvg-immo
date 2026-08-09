CREATE TABLE "outbound_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_class" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_deliveries_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "outbound_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Existing commission records predate client idempotency keys. Give each a
-- stable legacy key before making the new invariant mandatory; no history is
-- rewritten and old rows can never collide with browser UUIDs.
ALTER TABLE "lawyer_inquiries" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
UPDATE "lawyer_inquiries" SET "idempotency_key" = 'legacy:' || "id"::text WHERE "idempotency_key" IS NULL;--> statement-breakpoint
ALTER TABLE "lawyer_inquiries" ALTER COLUMN "idempotency_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "lawyer_inquiries" ADD COLUMN "delivery_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_outbound_deliveries_ready" ON "outbound_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
ALTER TABLE "lawyer_inquiries" ADD CONSTRAINT "lawyer_inquiries_user_id_idempotency_key" UNIQUE("user_id","idempotency_key");
