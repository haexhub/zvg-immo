CREATE TABLE "alert_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"saved_search_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_subscriptions_saved_search_id_key" UNIQUE("saved_search_id")
);
--> statement-breakpoint
ALTER TABLE "alert_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "api_usage" (
	"api_key_id" uuid NOT NULL,
	"day" date NOT NULL,
	"count" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "api_usage_api_key_id_day_pk" PRIMARY KEY("api_key_id","day")
);
--> statement-breakpoint
ALTER TABLE "api_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notified_matches" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"alert_subscription_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"notified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notified_matches_alert_subscription_id_platform_external_id_key" UNIQUE("alert_subscription_id","platform","external_id")
);
--> statement-breakpoint
ALTER TABLE "notified_matches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "saved_searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"filters" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "saved_searches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "watchlist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"authority" text,
	"case_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlist_items_user_id_platform_external_id_key" UNIQUE("user_id","platform","external_id")
);
--> statement-breakpoint
ALTER TABLE "watchlist_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "lawyer_inquiries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"lawyer_id" uuid NOT NULL,
	"platform" text,
	"external_id" text,
	"message" text NOT NULL,
	"commission_cents" integer,
	"commission_status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lawyer_inquiries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "lawyers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"firm" text,
	"email" text NOT NULL,
	"phone" text,
	"countries" text[] NOT NULL,
	"specialization" text,
	"languages" text[],
	"website" text,
	"commission_cents" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lawyers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "artifact_blobs" (
	"content_hash" text PRIMARY KEY NOT NULL,
	"s3_key" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"uploaded_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "artifact_blobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "artifact_captures" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"source_url" text
);
--> statement-breakpoint
ALTER TABLE "artifact_captures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "artifact_version_items" (
	"set_id" bigint NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"filename" text,
	"file_id" text,
	"source_url" text NOT NULL,
	"content_hash" text NOT NULL,
	"content_type" text NOT NULL,
	CONSTRAINT "artifact_version_items_set_id_ordinal_pk" PRIMARY KEY("set_id","ordinal")
);
--> statement-breakpoint
ALTER TABLE "artifact_version_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "artifact_versions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"set_hash" text NOT NULL,
	"version" integer NOT NULL,
	"document_count" integer NOT NULL,
	CONSTRAINT "artifact_versions_platform_external_id_set_hash_key" UNIQUE("platform","external_id","set_hash"),
	CONSTRAINT "artifact_versions_platform_external_id_version_key" UNIQUE("platform","external_id","version"),
	CONSTRAINT "uq_artifact_versions_identity" UNIQUE("id","platform","external_id")
);
--> statement-breakpoint
ALTER TABLE "artifact_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "auction_details" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"version" integer NOT NULL,
	"artifact_version_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"extracted_at" timestamp with time zone NOT NULL,
	"address" text,
	"description" text,
	"property_type" text,
	"land_area_sqm" numeric,
	"living_area_sqm" numeric,
	"rooms" numeric,
	"bedrooms" numeric,
	"bathrooms" numeric,
	"floor" text,
	"bathroom_has_tub" boolean,
	"bathroom_has_shower" boolean,
	"heating" text,
	"units" integer,
	"year_built" integer,
	"last_renovation_year" integer,
	"market_value" numeric,
	"currency" text,
	"market_value_eur" numeric,
	"condition" jsonb,
	"features" text[],
	"insights" jsonb,
	"planning_notes" jsonb,
	"renovation_notes" text,
	"starting_bid" numeric,
	"current_bid" numeric,
	"source_security_deposit" numeric,
	"security_deposit" numeric,
	"bidding_notes" text,
	"photo_count" integer DEFAULT 0 NOT NULL,
	"thumbnail_url" text,
	"extraction_source" text,
	"extraction_confidence" text,
	"llm_analyzed_at" timestamp with time zone,
	"document_summary" text,
	"extraction_texts" jsonb,
	"source_living_area_sqm" numeric,
	"source_land_area_sqm" numeric,
	"source_rooms" numeric,
	"market_value_text" text,
	"is_latest" boolean DEFAULT true NOT NULL,
	CONSTRAINT "auction_details_platform_external_id_version_key" UNIQUE("platform","external_id","version")
);
--> statement-breakpoint
ALTER TABLE "auction_details" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "auction_fetch_state" (
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"pdf_url" text,
	"pdf_url_upstream" text,
	"detail_url" text,
	"detail_url_upstream" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"photo_urls" text[],
	"source_updated_iso" timestamp with time zone,
	"detail_fetched_at" timestamp with time zone,
	"llm_batch_job" text,
	"llm_artifact_version_id" bigint,
	"llm_failures" integer DEFAULT 0 NOT NULL,
	"photos_checked_at" timestamp with time zone,
	"photo_failures" integer DEFAULT 0 NOT NULL,
	"photo_pipeline_version" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auction_fetch_state_platform_external_id_pk" PRIMARY KEY("platform","external_id")
);
--> statement-breakpoint
ALTER TABLE "auction_fetch_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "auction_photos" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"auction_details_id" bigint NOT NULL,
	"ordinal" integer NOT NULL,
	"file" text NOT NULL,
	"category" text NOT NULL,
	"caption" text,
	"is_property_photo" boolean NOT NULL,
	CONSTRAINT "auction_photos_auction_details_id_ordinal_key" UNIQUE("auction_details_id","ordinal")
);
--> statement-breakpoint
ALTER TABLE "auction_photos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "auctions" (
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"country" text NOT NULL,
	"region" text NOT NULL,
	"authority" text NOT NULL,
	"case_number" text NOT NULL,
	"title" text,
	"auction_date_iso" timestamp with time zone,
	"auction_date_text" text,
	"cancelled" boolean NOT NULL,
	"lat" numeric,
	"lng" numeric,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auctions_platform_external_id_pk" PRIMARY KEY("platform","external_id")
);
--> statement-breakpoint
ALTER TABLE "auctions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "auction_translations" (
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"lang" text NOT NULL,
	"content_hash" text NOT NULL,
	"status" text NOT NULL,
	"title" text,
	"description" text,
	"document_summary" text,
	"extraction_texts" jsonb,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"failed_config" text,
	"address" text,
	"version" integer NOT NULL,
	CONSTRAINT "auction_translations_platform_external_id_version_lang_pk" PRIMARY KEY("platform","external_id","version","lang"),
	CONSTRAINT "auction_translations_status_check" CHECK ("auction_translations"."status" IN ('pending', 'completed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "auction_translations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "content_translations" (
	"content_hash" text NOT NULL,
	"lang" text NOT NULL,
	"title" text,
	"description" text,
	"document_summary" text,
	"extraction_texts" jsonb,
	"address" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_translations_content_hash_lang_pk" PRIMARY KEY("content_hash","lang")
);
--> statement-breakpoint
ALTER TABLE "content_translations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "place_name_translations" (
	"name" text NOT NULL,
	"lang" text NOT NULL,
	"translated" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "place_name_translations_name_lang_pk" PRIMARY KEY("name","lang")
);
--> statement-breakpoint
ALTER TABLE "place_name_translations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "auction_observations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"platform" text NOT NULL,
	"country" text NOT NULL,
	"region" text NOT NULL,
	"external_id" text NOT NULL,
	"authority" text NOT NULL,
	"case_number" text NOT NULL,
	"title" text,
	"property_type" text,
	"land_area_sqm" numeric,
	"living_area_sqm" numeric,
	"rooms" numeric,
	"units" integer,
	"market_value_eur" numeric,
	"market_value" numeric,
	"currency" text,
	"auction_date_iso" timestamp with time zone,
	"cancelled" boolean NOT NULL,
	"payload" jsonb
);
--> statement-breakpoint
ALTER TABLE "auction_observations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "auction_insights" (
	"insight_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auction_insights_insight_id_content_hash_pk" PRIMARY KEY("insight_id","content_hash")
);
--> statement-breakpoint
ALTER TABLE "auction_insights" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "list_cache" (
	"country" text NOT NULL,
	"region" text NOT NULL,
	"result" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "list_cache_country_region_pk" PRIMARY KEY("country","region")
);
--> statement-breakpoint
ALTER TABLE "list_cache" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "llm_batch_jobs" (
	"job_name" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"item_count" integer NOT NULL,
	"custom_id_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error_message" text
);
--> statement-breakpoint
ALTER TABLE "llm_batch_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "location_enrichment" (
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"enrichment" jsonb NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "location_enrichment_platform_external_id_pk" PRIMARY KEY("platform","external_id")
);
--> statement-breakpoint
ALTER TABLE "location_enrichment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "task_run_errors" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"task" text NOT NULL,
	"platform" text,
	"external_id" text,
	"category" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_run_errors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "auction_geo_metrics" (
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"dist_sea_m" integer,
	"dist_lake_m" integer,
	"dist_river_m" integer,
	"dist_mountain_m" integer,
	"dist_airport_m" integer,
	"dist_ski_m" integer,
	"tourism_density_count" integer,
	"climate_cell_id" bigint,
	"point_hash" text,
	"features_epoch" integer DEFAULT 1 NOT NULL,
	"computed_at" timestamp with time zone,
	CONSTRAINT "auction_geo_metrics_platform_external_id_pk" PRIMARY KEY("platform","external_id")
);
--> statement-breakpoint
ALTER TABLE "auction_geo_metrics" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "climate_cells" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"lat" numeric NOT NULL,
	"lon" numeric NOT NULL,
	"summer_avg_temp_c" numeric,
	"fetched_at" timestamp with time zone,
	CONSTRAINT "climate_cells_lat_lon_key" UNIQUE("lat","lon")
);
--> statement-breakpoint
ALTER TABLE "climate_cells" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geo_features" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"country" text NOT NULL,
	"osm_type" text,
	"osm_id" bigint,
	"geom_3035" geometry(Geometry, 3035) NOT NULL,
	"features_epoch" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geo_features" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "osm_local_elements" (
	"osm_type" text NOT NULL,
	"osm_id" bigint NOT NULL,
	"geom" geometry(Geometry, 4326) NOT NULL,
	"tags" jsonb NOT NULL,
	"country" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "osm_local_elements_osm_type_osm_id_pk" PRIMARY KEY("osm_type","osm_id")
);
--> statement-breakpoint
ALTER TABLE "osm_local_elements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "alert_subscriptions" ADD CONSTRAINT "alert_subscriptions_saved_search_id_saved_searches_id_fk" FOREIGN KEY ("saved_search_id") REFERENCES "public"."saved_searches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notified_matches" ADD CONSTRAINT "fk_notified_matches_alert_subscription" FOREIGN KEY ("alert_subscription_id") REFERENCES "public"."alert_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lawyer_inquiries" ADD CONSTRAINT "lawyer_inquiries_lawyer_id_lawyers_id_fk" FOREIGN KEY ("lawyer_id") REFERENCES "public"."lawyers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_captures" ADD CONSTRAINT "artifact_captures_content_hash_artifact_blobs_content_hash_fk" FOREIGN KEY ("content_hash") REFERENCES "public"."artifact_blobs"("content_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_captures" ADD CONSTRAINT "fk_artifact_captures_auction" FOREIGN KEY ("platform","external_id") REFERENCES "public"."auctions"("platform","external_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_version_items" ADD CONSTRAINT "artifact_version_items_set_id_artifact_versions_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."artifact_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_version_items" ADD CONSTRAINT "fk_artifact_version_items_blob" FOREIGN KEY ("content_hash") REFERENCES "public"."artifact_blobs"("content_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "fk_artifact_versions_auction" FOREIGN KEY ("platform","external_id") REFERENCES "public"."auctions"("platform","external_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_details" ADD CONSTRAINT "fk_auction_details_auction" FOREIGN KEY ("platform","external_id") REFERENCES "public"."auctions"("platform","external_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_details" ADD CONSTRAINT "fk_auction_details_artifact_version" FOREIGN KEY ("artifact_version_id","platform","external_id") REFERENCES "public"."artifact_versions"("id","platform","external_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_fetch_state" ADD CONSTRAINT "fk_auction_fetch_state_auction" FOREIGN KEY ("platform","external_id") REFERENCES "public"."auctions"("platform","external_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_photos" ADD CONSTRAINT "auction_photos_auction_details_id_auction_details_id_fk" FOREIGN KEY ("auction_details_id") REFERENCES "public"."auction_details"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_translations" ADD CONSTRAINT "fk_auction_translations_details" FOREIGN KEY ("platform","external_id","version") REFERENCES "public"."auction_details"("platform","external_id","version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_enrichment" ADD CONSTRAINT "fk_location_enrichment_auction" FOREIGN KEY ("platform","external_id") REFERENCES "public"."auctions"("platform","external_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_geo_metrics" ADD CONSTRAINT "auction_geo_metrics_climate_cell_id_climate_cells_id_fk" FOREIGN KEY ("climate_cell_id") REFERENCES "public"."climate_cells"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_geo_metrics" ADD CONSTRAINT "fk_auction_geo_metrics_auction" FOREIGN KEY ("platform","external_id") REFERENCES "public"."auctions"("platform","external_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_inquiries_lawyer_time" ON "lawyer_inquiries" USING btree ("lawyer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_inquiries_user_time" ON "lawyer_inquiries" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_lawyers_countries" ON "lawyers" USING gin ("countries");--> statement-breakpoint
CREATE INDEX "idx_capt_identity_time" ON "artifact_captures" USING btree ("platform","external_id","captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_capt_hash" ON "artifact_captures" USING btree ("content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_capt_unique_auction_hash" ON "artifact_captures" USING btree ("kind","platform","external_id","content_hash") WHERE "artifact_captures"."kind" = 'auction';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_capt_unique_source_hash" ON "artifact_captures" USING btree ("kind","platform","external_id",(coalesce("source_url", '')),"content_hash") WHERE "artifact_captures"."kind" <> 'auction';--> statement-breakpoint
CREATE INDEX "idx_doc_set_items_hash" ON "artifact_version_items" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "idx_doc_sets_identity_version" ON "artifact_versions" USING btree ("platform","external_id","version" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_auction_details_identity_version" ON "auction_details" USING btree ("platform","external_id","version" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_auction_details_property_type" ON "auction_details" USING btree ("property_type");--> statement-breakpoint
CREATE INDEX "idx_auction_details_living_area" ON "auction_details" USING btree ("living_area_sqm");--> statement-breakpoint
CREATE INDEX "idx_auction_details_land_area" ON "auction_details" USING btree ("land_area_sqm");--> statement-breakpoint
CREATE INDEX "idx_auction_details_year_built" ON "auction_details" USING btree ("year_built");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_auction_details_latest" ON "auction_details" USING btree ("platform","external_id") WHERE "auction_details"."is_latest";--> statement-breakpoint
CREATE INDEX "idx_auction_fetch_state_llm_batch_job" ON "auction_fetch_state" USING btree ("llm_batch_job") WHERE "auction_fetch_state"."llm_batch_job" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_auction_photos_details" ON "auction_photos" USING btree ("auction_details_id","ordinal");--> statement-breakpoint
CREATE INDEX "idx_auctions_country_region" ON "auctions" USING btree ("country","region");--> statement-breakpoint
CREATE INDEX "idx_auction_translations_status" ON "auction_translations" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "idx_obs_country_region_time" ON "auction_observations" USING btree ("country","region","captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_obs_platform_zvgid_time" ON "auction_observations" USING btree ("platform","external_id","captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_obs_az_time" ON "auction_observations" USING btree ("authority","case_number","captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_location_enrichment_checked_at" ON "location_enrichment" USING btree ("checked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_task_run_errors_task_created" ON "task_run_errors" USING btree ("task","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_geo_features_geom_3035" ON "geo_features" USING gist ("geom_3035");--> statement-breakpoint
CREATE INDEX "idx_geo_features_kind" ON "geo_features" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "idx_geo_features_kind_country" ON "geo_features" USING btree ("kind","country");--> statement-breakpoint
CREATE INDEX "idx_osm_local_elements_geom" ON "osm_local_elements" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "idx_osm_local_elements_country" ON "osm_local_elements" USING btree ("country");--> statement-breakpoint
CREATE INDEX "idx_osm_local_elements_country_natural" ON "osm_local_elements" USING btree ("country",("tags" ->> 'natural'));--> statement-breakpoint
CREATE INDEX "idx_osm_local_elements_country_waterway" ON "osm_local_elements" USING btree ("country",("tags" ->> 'waterway'));--> statement-breakpoint
CREATE POLICY "own_rows" ON "alert_subscriptions" AS PERMISSIVE FOR ALL TO public USING ("alert_subscriptions"."user_id" = auth.uid()) WITH CHECK ("alert_subscriptions"."user_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "own_rows" ON "api_keys" AS PERMISSIVE FOR ALL TO public USING ("api_keys"."user_id" = auth.uid()) WITH CHECK ("api_keys"."user_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "own_rows" ON "saved_searches" AS PERMISSIVE FOR ALL TO public USING ("saved_searches"."user_id" = auth.uid()) WITH CHECK ("saved_searches"."user_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "own_rows" ON "watchlist_items" AS PERMISSIVE FOR ALL TO public USING ("watchlist_items"."user_id" = auth.uid()) WITH CHECK ("watchlist_items"."user_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "own_rows" ON "lawyer_inquiries" AS PERMISSIVE FOR ALL TO public USING ("lawyer_inquiries"."user_id" = auth.uid()) WITH CHECK ("lawyer_inquiries"."user_id" = auth.uid());