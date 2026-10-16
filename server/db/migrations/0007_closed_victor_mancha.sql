ALTER TABLE "climate_cells" ADD COLUMN "winter_avg_temp_c" numeric;--> statement-breakpoint
ALTER TABLE "climate_cells" ADD COLUMN "annual_precip_mm" integer;--> statement-breakpoint
ALTER TABLE "climate_cells" ADD COLUMN "frost_days" integer;--> statement-breakpoint
ALTER TABLE "climate_cells" ADD COLUMN "monthly" jsonb;--> statement-breakpoint
ALTER TABLE "climate_cells" ADD COLUMN "source_version" text;