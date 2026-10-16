-- `piste:type=downhill` also maps indoor ski halls and artificial slopes in
-- flat country. Bergabfahrt is intentionally stricter: an outdoor piste
-- must sit within 25km of a qualified (>=300m) natural peak. Remove the
-- now-invalid legacy features and refresh the cached distance immediately,
-- rather than waiting for the next full geo-feature rebuild.
DELETE FROM "geo_features" AS f
WHERE f."kind" = 'ski_downhill'
  AND NOT EXISTS (
    SELECT 1
    FROM "osm_local_elements" AS o
    WHERE o."country" = f."country"
      AND o."osm_type" = f."osm_type"
      AND o."osm_id" = f."osm_id"
      AND o."tags" ->> 'piste:type' = 'downhill'
      AND COALESCE(o."tags" ->> 'indoor', '') NOT IN ('yes', 'true', '1')
      AND EXISTS (
        SELECT 1
        FROM "osm_local_elements" AS p
        WHERE p."tags" ->> 'natural' = 'peak'
          AND p."tags" ->> 'ele' ~ '^-?[0-9]+(\.[0-9]+)?$'
          AND (p."tags" ->> 'ele')::numeric >= 300
          AND ST_DWithin(p."geom"::geography, o."geom"::geography, 25000)
      )
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
