-- A lift alone is not enough evidence for an alpine ski area: OSM also uses
-- aerialway for urban and sightseeing transport. Remove the legacy feature
-- rows that were created from lifts without an explicitly tagged downhill
-- piste, then recompute just that distance from the corrected feature set.
DELETE FROM "geo_features" AS f
WHERE f."kind" = 'ski_downhill'
  AND NOT EXISTS (
    SELECT 1
    FROM "osm_local_elements" AS o
    WHERE o."country" = f."country"
      AND o."osm_type" = f."osm_type"
      AND o."osm_id" = f."osm_id"
      AND o."tags" ->> 'piste:type' = 'downhill'
  );
--> statement-breakpoint
UPDATE "auction_geo_metrics"
SET "dist_ski_downhill_m" = (
  SELECT ST_Distance(
    f."geom_3035",
    ST_Transform(ST_SetSRID(ST_MakePoint(a."lng", a."lat"), 4326), 3035)
  )::integer
  FROM "geo_features" AS f
  WHERE f."kind" = 'ski_downhill'
    AND f."features_epoch" = (SELECT MAX("epoch") FROM "geo_features_epochs")
    AND ST_DWithin(
      f."geom_3035",
      ST_Transform(ST_SetSRID(ST_MakePoint(a."lng", a."lat"), 4326), 3035),
      200000
    )
  ORDER BY f."geom_3035" <-> ST_Transform(ST_SetSRID(ST_MakePoint(a."lng", a."lat"), 4326), 3035)
  LIMIT 1
)
FROM "auctions" AS a
WHERE a."platform" = "auction_geo_metrics"."platform"
  AND a."external_id" = "auction_geo_metrics"."external_id"
  AND a."lat" IS NOT NULL
  AND a."lng" IS NOT NULL;
