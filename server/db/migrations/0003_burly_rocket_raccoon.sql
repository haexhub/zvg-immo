CREATE INDEX "idx_osm_local_elements_tag_natural" ON "osm_local_elements" USING btree (("tags" ->> 'natural'));--> statement-breakpoint
CREATE INDEX "idx_osm_local_elements_tag_waterway" ON "osm_local_elements" USING btree (("tags" ->> 'waterway'));--> statement-breakpoint
CREATE INDEX "idx_osm_local_elements_tag_water" ON "osm_local_elements" USING btree (("tags" ->> 'water'));--> statement-breakpoint
CREATE INDEX "idx_osm_local_elements_tag_place" ON "osm_local_elements" USING btree (("tags" ->> 'place'));--> statement-breakpoint
CREATE INDEX "idx_osm_local_elements_tag_aeroway" ON "osm_local_elements" USING btree (("tags" ->> 'aeroway'));--> statement-breakpoint
CREATE INDEX "idx_osm_local_elements_geog" ON "osm_local_elements" USING gist ((("geom")::geography));