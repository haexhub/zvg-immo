CREATE TABLE "status_daily_snapshots" (
	"snapshot_date" date NOT NULL,
	"country" text NOT NULL,
	"kind" text NOT NULL,
	"target_lang" text DEFAULT '' NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"pending" integer DEFAULT 0 NOT NULL,
	"open" integer DEFAULT 0 NOT NULL,
	"error" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_daily_snapshots_snapshot_date_country_kind_target_lang_pk" PRIMARY KEY("snapshot_date","country","kind","target_lang")
);
--> statement-breakpoint
ALTER TABLE "status_daily_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "idx_status_daily_snapshots_country_date" ON "status_daily_snapshots" USING btree ("country","snapshot_date" DESC NULLS LAST);