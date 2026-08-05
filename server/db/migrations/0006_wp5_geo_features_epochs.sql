CREATE TABLE "geo_features_epochs" (
	"epoch" integer PRIMARY KEY NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geo_features_epochs" ENABLE ROW LEVEL SECURITY;