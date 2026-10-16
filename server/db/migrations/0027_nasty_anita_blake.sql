CREATE TABLE "tourism_grid_cells" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"cell_x" integer NOT NULL,
	"cell_y" integer NOT NULL,
	"category" text NOT NULL,
	"count" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tourism_grid_cells_cell_category_key" UNIQUE("cell_x","cell_y","category")
);
--> statement-breakpoint
ALTER TABLE "tourism_grid_cells" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "idx_tourism_grid_cells_category_cell" ON "tourism_grid_cells" USING btree ("category","cell_x","cell_y");