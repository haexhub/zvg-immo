CREATE TABLE "auction_observation_heads" (
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload_hash" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auction_observation_heads_platform_external_id_kind_pk" PRIMARY KEY("platform","external_id","kind")
);
--> statement-breakpoint
ALTER TABLE "auction_observation_heads" ENABLE ROW LEVEL SECURITY;