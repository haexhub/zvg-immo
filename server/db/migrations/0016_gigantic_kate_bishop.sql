CREATE TABLE "auction_relationships" (
	"left_platform" text NOT NULL,
	"left_external_id" text NOT NULL,
	"right_platform" text NOT NULL,
	"right_external_id" text NOT NULL,
	"kind" text NOT NULL,
	"confidence" text NOT NULL,
	"source" text DEFAULT 'auto' NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auction_relationships_left_platform_left_external_id_right_platform_right_external_id_pk" PRIMARY KEY("left_platform","left_external_id","right_platform","right_external_id")
);
--> statement-breakpoint
ALTER TABLE "auction_relationships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auction_relationships" ADD CONSTRAINT "fk_auction_relationships_left_auction" FOREIGN KEY ("left_platform","left_external_id") REFERENCES "public"."auctions"("platform","external_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_relationships" ADD CONSTRAINT "fk_auction_relationships_right_auction" FOREIGN KEY ("right_platform","right_external_id") REFERENCES "public"."auctions"("platform","external_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_auction_relationships_left" ON "auction_relationships" USING btree ("left_platform","left_external_id");--> statement-breakpoint
CREATE INDEX "idx_auction_relationships_right" ON "auction_relationships" USING btree ("right_platform","right_external_id");--> statement-breakpoint
ALTER TABLE "auction_relationships" ADD CONSTRAINT "auction_relationships_canonical_pair" CHECK (("left_platform", "left_external_id") < ("right_platform", "right_external_id"));--> statement-breakpoint
WITH current_details AS (
  SELECT platform, external_id, address
  FROM auction_details
  WHERE is_latest = true
), candidates AS (
  SELECT a.platform, a.external_id, a.country, lower(trim(a.authority)) AS authority_key,
    lower(trim(regexp_replace(a.case_number, E'\\s+', ' ', 'g'))) AS case_raw,
    a.auction_date_iso,
    regexp_replace(replace(translate(lower(coalesce(d.address, '')), 'äöü', 'aou'), 'ß', 'ss'), '[^[:alnum:]]', '', 'g') AS address_key
  FROM auctions a
  LEFT JOIN current_details d ON d.platform = a.platform AND d.external_id = a.external_id
), normalized AS (
  SELECT *, regexp_match(case_raw, E'^0*([0-9]+)\\s*k\\s*0*([0-9]+)\\s*/\\s*0*([0-9]{2,4})$') AS case_parts
  FROM candidates
), keyed AS (
  SELECT *, CASE WHEN case_parts IS NULL THEN NULL ELSE
    (case_parts[1]::integer)::text || ' k ' || (case_parts[2]::integer)::text || '/' || right(case_parts[3], 2)
  END AS case_key
  FROM normalized
), edges AS (
  SELECT l.platform AS left_platform, l.external_id AS left_external_id,
    r.platform AS right_platform, r.external_id AS right_external_id,
    'same_proceeding'::text AS kind, 'high'::text AS confidence,
    jsonb_build_object('migrationBackfill', true, 'sameAuthority', true, 'sameCaseNumber', true, 'sameAuctionDate', true) AS evidence,
    0 AS priority
  FROM keyed l
  JOIN keyed r ON l.country = r.country AND l.authority_key = r.authority_key
    AND l.case_key IS NOT NULL AND l.case_key = r.case_key
    AND l.auction_date_iso IS NOT DISTINCT FROM r.auction_date_iso
    AND (l.platform, l.external_id) < (r.platform, r.external_id)
  UNION ALL
  SELECT l.platform, l.external_id, r.platform, r.external_id,
    'same_address'::text, 'medium'::text,
    jsonb_build_object('migrationBackfill', true, 'sameAddress', true), 1
  FROM keyed l
  JOIN keyed r ON l.country = r.country AND l.address_key = r.address_key
    AND length(l.address_key) >= 8 AND l.address_key ~ '[0-9]'
    AND (l.platform, l.external_id) < (r.platform, r.external_id)
), deduplicated AS (
  SELECT DISTINCT ON (left_platform, left_external_id, right_platform, right_external_id)
    left_platform, left_external_id, right_platform, right_external_id, kind, confidence, evidence
  FROM edges
  ORDER BY left_platform, left_external_id, right_platform, right_external_id, priority
)
INSERT INTO auction_relationships (
  left_platform, left_external_id, right_platform, right_external_id, kind, confidence, source, evidence
)
SELECT left_platform, left_external_id, right_platform, right_external_id, kind, confidence, 'auto', evidence
FROM deduplicated;
