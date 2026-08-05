# WP-4 — `geo_features`: query-fertiger POI-Layer

Datum: 2026-08-04
Teil von [GIS-Architektur](2026-08-04-gis-scaling-architecture.md). Abhängig von: [WP-0](2026-08-04-gis-wp0-schema-neuaufbau.md) (Drizzle-Schema für die Migration).
Aufwand: 2–3 Tage. Repo: `zvg-immo`.

> **Status 2026-08-05: WP-0 ist erledigt (PR #313), dieses WP ist bereit zu starten.** Der `geometry(Geometry, srid)`-`customType` aus dem WP-2-Verweis unten existiert bereits — WP-2 ist obsolet, der `customType` lebt jetzt in [server/db/schema/geo.ts](server/db/schema/geo.ts). **`geo_features` und `auction_geo_metrics` sind als leere Skeleton-Tabellen bereits angelegt** (Migration aus WP-0) — dieses WP befüllt sie über den Aufbau-Job, legt sie nicht neu an. Die tatsächlichen Spalten weichen leicht vom Sketch unten ab:
> - `geo_features`: `id, kind, name, country, osm_type, osm_id, geom_3035, features_epoch, created_at` — **kein** `source_ref`/`attrs`; Rückverfolgung läuft über `osm_type`+`osm_id` (zwei Spalten statt einer zusammengesetzten), `country` ist bereits eine eigene Spalte (nicht in `attrs`), `features_epoch` ist bereits modelliert (Default `1`) statt erst hier zu entstehen.
> - `auction_geo_metrics`: PK ist `(platform, external_id)`, FK auf `auctions`; `dist_sea_m/dist_lake_m/dist_river_m/dist_mountain_m/dist_airport_m/dist_ski_m` und `tourism_density_count` sind bereits als Spalten angelegt (weitere WP-6-Kategorien sind additive Migrationen später), plus `climate_cell_id` (FK auf `climate_cells`), `point_hash`, `features_epoch`, `computed_at`.
>
> Indizes existieren ebenfalls bereits: `idx_geo_features_geom_3035` (GIST), `idx_geo_features_kind`, `idx_geo_features_kind_country`. Der Aufbau-Job unten kann direkt gegen dieses Schema schreiben — Schritt "Datenmodell anlegen" entfällt, es bleibt der Aufbau-Job (Normalisierung aus `osm_local_elements`) als eigentlicher Inhalt dieses WP.

## Warum

`osm_local_elements` ist ein Rohdatendump: 44,5 Mio. Zeilen / 20 GB, davon **90 % `building`**, Geometrien in EPSG:4326, Kategorien nur als `jsonb`-Tags. Jede Suche muss daraus zur Laufzeit erst die Semantik ableiten („Meer ist coastline *oder* beach *oder* bay …") — und genau diese OR-Ketten sind die Ursache des Serverausfalls, weil sie an einem einzigen fehlenden Index zerbrechen ([WP-1](2026-08-04-gis-wp1-index-notfall.md)).

`geo_features` ist die Antwort: dieselben Daten, aber einmal normalisiert, projiziert und zerlegt. Rund 10 % der Rohzeilen sind dafür überhaupt relevant.

## Ziel

Eine Tabelle, gegen die eine Nächster-Nachbar-Abfrage pro Kategorie in Millisekunden läuft, ohne `jsonb`-Ausdruck, ohne Cast und ohne OR-Kette.

## Datenmodell

**Historischer Sketch, durch WP-0 überholt — die Tabelle existiert bereits mit abweichenden Spalten.** Siehe Status oben und [server/db/schema/geo.ts](../../server/db/schema/geo.ts) für die tatsächlichen Spalten (`country`, `osm_type`, `osm_id` statt `source_ref`/`attrs`). Ursprünglicher Entwurf, nur noch als Beleg für die Entscheidungen (EPSG:3035, Zerlegung, `kind`) unten:

```sql
CREATE TABLE geo_features (
  id         bigserial PRIMARY KEY,
  kind       text NOT NULL,       -- 'sea' | 'lake' | 'ski_area' | 'hiking_route' | …
  name       text,                -- für "nächstes Skigebiet: Åre"
  geom_3035  geometry(Geometry, 3035) NOT NULL,
  source_ref text NOT NULL,       -- 'way/12345' — Rückverfolgung nach OSM
  attrs      jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX ON geo_features USING GIST (geom_3035);
CREATE INDEX ON geo_features (kind);
```

Als Drizzle-Schema (`server/db/schema/geo-features.ts`); der GIST-Index geht deklarativ über `index().using('gist', table.geom3035)`. Für die Geometriespalte wird der `customType` gebraucht, der in [WP-2](2026-08-04-gis-wp2-drizzle-fundament.md) beschrieben ist — Drizzles eingebautes `geometry()` deckt nur `Point` ab, nicht `geometry(Geometry, …)` mit gemischten Typen. Dieser Abschnitt von WP-2 bleibt trotz WP-0 gültig.

### Drei Entscheidungen und ihr Grund

**EPSG:3035 statt 4326.** ETRS89-LAEA ist der INSPIRE-Standard für Europa und rechnet in **Metern**. Damit liefert der KNN-Operator `<->` direkt Meter *und* nutzt den GIST-Index. Heute prädiziert alles auf `geom::geography`, worauf ein Index auf `geom` nicht passt — deshalb hat `idx_osm_local_elements_geom` (1 988 MB) **0 Scans**. Mit 3035 verschwindet der Cast und damit das Problem. Wo es auf den Meter ankommt, kann mit `ST_Distance(…::geography)` nachgerechnet werden.

**Geometrien werden zerlegt.** Ein `natural=coastline`-Way kann hunderte Kilometer lang sein; seine Bounding Box umspannt dann halbe Länder, und ein Geo-Index schließt kaum etwas aus. In der WP-1-Messung war das der Rest der Kosten: selbst mit `BitmapOr` las die Query noch 6 686 Buffer, weil `ST_DWithin` auf ganzen Küstenlinien arbeitet. `ST_Subdivide(geom, 128)` schneidet das in Stücke mit kleinen Bounding Boxes.

Nur Linien und große Flächen zerlegen, keine Punkte (dort ist es sinnlos und kostet nur Zeilen). Eine Küstenlinie wird zu vielen Zeilen — gewollt; `kind`, `name` und `source_ref` bleiben identisch, und der Nachbarschaftsjob nimmt ohnehin nur das Minimum.

**`kind` statt Roh-Tags.** Die Tag-Logik wird einmal beim Aufbau angewandt. Das eliminiert die strukturelle Fragilität der heutigen Lösung: kein `BitmapOr`, dessen Zusammenbruch von einem einzelnen Index abhängt.

## Kind-Mapping

Aus `osm_local_elements` per SQL. Die Zuordnung ist der inhaltliche Kern dieses WP:

| `kind` | Quelle (OSM-Tags) |
|---|---|
| `sea` | `natural` ∈ {coastline, beach, bay, strait}, `water` ∈ {sea, lagoon}, `place` ∈ {sea, ocean} |
| `lake` | `natural=water` ohne `water` ∈ {river, stream, canal, ditch} |
| `river` | `waterway` ∈ {river, canal} |
| `peak` | `natural=peak` |
| `airport` | `aeroway=aerodrome` |
| `ski_area` | `landuse=winter_sports`, `piste:type` (beliebig), `aerialway` ∈ {gondola, chair_lift, cable_car, drag_lift, …} |
| `swimming` | `leisure=swimming_area`, `sport=swimming`, `natural=beach`, `amenity` ∈ {public_bath, spa} |
| `marina` | `leisure` ∈ {marina, slipway} |
| `hiking_route` | `route=hiking` (Relation), `sac_scale` (beliebig) |
| `mtb_route` | `route=mtb`, `mtb` ∈ {yes, designated}, `mtb:scale` (beliebig) |
| `paddling` | `canoe` ∈ {yes, designated}, `whitewater` (beliebig) |
| `fishing` | `leisure=fishing`, `sport=fishing`, `fishing=yes` |
| `attraction` | `tourism` ∈ {attraction, museum, viewpoint, theme_park, zoo}, `historic` ∈ {castle, monument, memorial, archaeological_site, fort} |
| `tourism_supply` | `tourism` ∈ {camp_site, caravan_site, hotel, guest_house, apartment, alpine_hut}, `leisure` ∈ {golf_course, water_park, nature_reserve} |

`building` wird **nicht** übernommen — 90 % der Rohdaten, ohne Wert für diese Kategorien.

**Wichtig:** Die Tags für `ski_area`, `hiking_route`, `mtb_route`, `paddling`, `fishing`, `attraction` und `tourism_supply` werden heute **nicht importiert**. Sie kommen erst mit [WP-6](2026-08-04-gis-wp6-osm-datenausbau.md). Dieses WP soll das Mapping trotzdem vollständig anlegen — die betroffenen `kind`s bleiben dann einfach leer, bis der Reimport gelaufen ist. Das ist besser, als das Mapping später zweimal anzufassen.

`lake` braucht eine Ausschlussbedingung: `natural=water` umfasst auch Flussflächen. Ohne den Ausschluss meldet der Filter „Badesee in 200 m", wo ein Fluss liegt.

## Aufbau-Job

Wiederholbar nach jedem OSM-Reimport — aber nicht durch reines Anhängen, sonst verdoppelt ein zweiter Lauf jeden `kind`, weil `ST_Subdivide` denselben Way wieder in mehrere Zeilen zerlegt und `(osm_type, osm_id)` dadurch **nicht** eindeutig ist (keine Unique-Constraint in `geo_features`, mehrere Segmente teilen sich die Quelle). Idempotenzstrategie: jeder vollständige Aufbau schreibt unter einer **neuen** `features_epoch` (`SELECT max(features_epoch) + 1 FROM geo_features`), und erst nach erfolgreichem Durchlauf aller `kind`s werden Zeilen mit altem Epoch gelöscht (`DELETE FROM geo_features WHERE features_epoch < $neuer_epoch`) — das hält den alten Stand für laufende Suchanfragen erreichbar, bis der neue vollständig steht, und macht einen erneuten Lauf sicher wiederholbar. Ablauf pro `kind`:

```sql
INSERT INTO geo_features (kind, name, country, osm_type, osm_id, geom_3035, features_epoch)
SELECT
  'sea',
  o.tags ->> 'name',
  o.country,
  o.osm_type,
  o.osm_id,
  ST_Subdivide(ST_Transform(o.geom, 3035), 128),
  $neuer_epoch
FROM osm_local_elements o
WHERE o.tags ->> 'natural' IN ('coastline','beach','bay','strait')
   OR o.tags ->> 'water' IN ('sea','lagoon')
   OR o.tags ->> 'place' IN ('sea','ocean');
```

`ST_Subdivide` ist eine set-returning function und vervielfacht die Zeile automatisch.

Randbedingungen:
- **Eigener Connection-Pool mit hartem Limit, off-peak.** Der OSM-Reimport hat am 2026-08-03 durch Connection-Erschöpfung einen Prod-Totalausfall verursacht; dieser Job liest dieselbe 20-GB-Tabelle.
- **Pro `kind` committen**, nicht alles in einer Transaktion — sonst hält der Lauf stundenlang Locks und ein Fehler in `kind` 14 verwirft die 13 davor.
- **`features_epoch`**: ein Zähler, der bei jedem vollständigen Aufbau steigt. Er ist das Invalidierungssignal für [WP-5](2026-08-04-gis-wp5-precompute-suche.md) und muss hier entstehen, nicht dort.
- **`ANALYZE geo_features`** am Ende. Ohne aktuelle Statistiken wählt der Planner Seq Scans — genau der Fehler, der in `import.sh` deshalb schon explizit behandelt wird.

Der Aufbau ist Batch-Arbeit ohne Latenzanforderung. Perfekte Indexnutzung ist hier weniger wichtig als im Suchpfad.

## Verifikation

1. Zeilenzahl je `kind` plausibel. Referenz aus der Messung: `natural=coastline` hat 1 609 Rohzeilen in DE+BG; nach `ST_Subdivide` deutlich mehr, aber in derselben Größenordnung mal Segmentanzahl.
2. Die neuen `kind`s (`ski_area` usw.) sind leer — erwartet, bis WP-6 läuft. Explizit festhalten, damit es später nicht als Bug gesucht wird.
3. Tabellengröße messen und mit den 20 GB der Rohtabelle vergleichen. Erwartung: ein kleiner Bruchteil. Wenn nicht, ist `ST_Subdivide` zu aggressiv parametrisiert.
4. **Der entscheidende Test** — eine KNN-Abfrage muss den Index nutzen und im Millisekundenbereich liegen:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT name, ST_Distance(geom_3035, ST_Transform(ST_SetSRID(ST_MakePoint(10.0,54.3),4326),3035)) AS d
FROM geo_features
WHERE kind = 'sea'
ORDER BY geom_3035 <-> ST_Transform(ST_SetSRID(ST_MakePoint(10.0,54.3),4326),3035)
LIMIT 1;
```
Im Plan muss ein **Index Scan** auf dem GIST-Index stehen, kein Sort und kein Seq Scan. Vergleichswerte: 16 585 ms (heute), 147 ms (Rohtabelle mit Tag-Index).
5. Plausibilitätsprüfung gegen die Realität: für 3–5 Adressen mit bekannter Lage die berechnete Distanz zur Küste manuell auf einer Karte nachmessen. Ein Vorzeichenfehler bei der Projektion fällt sonst erst in der UI auf.

## Fallstricke

- **`ST_Transform` vor `ST_Subdivide`**, nicht danach — Zerlegen in 4326 und dann Projizieren erzeugt an Segmentgrenzen Ungenauigkeiten.
- **`ST_Subdivide` auf Punkten** ist wirkungslos, kostet aber Laufzeit. Nach Geometrietyp verzweigen.
- **Ungültige Geometrien:** OSM enthält selbstschneidende Polygone. `ST_Subdivide` kann daran scheitern und den ganzen `kind` abbrechen. `ST_MakeValid` davor, oder fehlerhafte Zeilen protokollieren und überspringen — aber **nicht stillschweigend** verwerfen: ein `kind`, der zu 30 % fehlt, ist schlimmer als einer, der fehlt.
- **`lake` ohne Fluss-Ausschluss** → falsche „Badesee"-Treffer.
- **Kein `ANALYZE`** → Planner wählt Seq Scans, und die Messung in Schritt 4 sieht künstlich schlecht aus.
