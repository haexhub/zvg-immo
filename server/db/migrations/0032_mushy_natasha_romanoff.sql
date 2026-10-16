CREATE TABLE "document_markdown" (
	"pdf_content_hash" text PRIMARY KEY NOT NULL,
	"markdown_content_hash" text,
	"page_count" integer,
	"converted_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "document_markdown" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_markdown" ADD CONSTRAINT "document_markdown_pdf_content_hash_artifact_blobs_content_hash_fk" FOREIGN KEY ("pdf_content_hash") REFERENCES "public"."artifact_blobs"("content_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_markdown" ADD CONSTRAINT "document_markdown_markdown_content_hash_artifact_blobs_content_hash_fk" FOREIGN KEY ("markdown_content_hash") REFERENCES "public"."artifact_blobs"("content_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_document_markdown_failed" ON "document_markdown" USING btree ("failed_at");