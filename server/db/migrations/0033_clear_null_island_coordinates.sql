-- Sources signal "no location" as 0/0 (zvbawu's [0, 0], dga-ag's Number('')).
-- usableCoordinates() rejects that since 4dbad7b, but only rows a later crawl
-- rewrites get cleaned up; expired auctions are never crawled again and keep
-- "null island" in the Gulf of Guinea. Clear the position so the geocode task
-- can fill it from the address, and drop what was computed for 0/0: geo
-- metrics (distances to the sea etc.) and the stored location enrichment.
-- The geo-metric and enrichment tasks recompute both once a real point exists.
DELETE FROM "auction_geo_metrics" AS m
USING "auctions" AS a
WHERE a."platform" = m."platform"
  AND a."external_id" = m."external_id"
  AND a."lat" = 0
  AND a."lng" = 0;
--> statement-breakpoint
DELETE FROM "location_enrichment"
WHERE ("enrichment" ->> 'lat')::double precision = 0
  AND ("enrichment" ->> 'lng')::double precision = 0;
--> statement-breakpoint
UPDATE "auctions" SET "lat" = NULL, "lng" = NULL
WHERE "lat" = 0 AND "lng" = 0;
