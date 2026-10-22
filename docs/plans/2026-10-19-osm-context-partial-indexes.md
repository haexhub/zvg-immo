# OSM-Kontext: zwei partielle Indizes gegen die Read-Timeouts

Stand: 2026-10-22. Status: **Indizes 1 und 2 auf Prod angelegt (2026-10-22, je ~2 min, beide valide). Index 3 (Zugrouten) steht noch aus.**

## Problem

Der External-Enrichment-Task meldet in jedem Lauf `Query read timeout` für dieselben Auktionen (zvbawu Karlsruhe/Mannheim/Heidelberg/Freiburg, vereinzelt alo und kip). Das Logging aus #525 (`[osm-context] … failed|slow …`) zeigt, welche Abfragen es sind:

| Kategorie | Radius | Dauer unter Last | Treffer |
|---|---|---|---|
| `railway=station\|halt\|tram_stop` | 15 km | 5–12 s | 16–34 |
| `place=city\|town\|…` | 30 km | 2–11 s | 380–570 |

Beide liefern wenige Zeilen, sind aber langsam. `EXPLAIN ANALYZE` (Karlsruhe, Prod) für den Bahnhof: Index-Scan auf `idx_osm_local_elements_geog`, **357 650 Zeilen im 15-km-Umkreis**, danach `Rows Removed by Filter: 357650`, 2,7 s allein, deutlich mehr bei den ~25 gleichzeitigen Abfragen eines Kontexts. Für `railway` gibt es keinen Tag-Index, der `place`-Index wird von der `ST_DWithin`-Form nicht benutzt. Die DB selbst ist dabei im Leerlauf; es ist die Summe der Abfragen eines Kontexts.

## Lösung

Zwei **partielle** GiST-Indizes auf demselben `geom::geography`-Ausdruck wie `idx_osm_local_elements_geog`, begrenzt auf genau die Tag-Werte, die `osm-location-context.ts` abfragt:

```sql
CREATE INDEX CONCURRENTLY idx_osm_local_elements_geog_railway_station
  ON osm_local_elements USING gist ((geom::geography))
  WHERE (tags ->> 'railway') IN ('station', 'halt', 'tram_stop');

CREATE INDEX CONCURRENTLY idx_osm_local_elements_geog_place
  ON osm_local_elements USING gist ((geom::geography))
  WHERE (tags ->> 'place') IN ('city', 'town', 'suburb', 'village', 'hamlet', 'island', 'municipality');
```

Die Prädikate sind absichtlich wortgleich mit den Wertelisten in `CATEGORIES`. Der Planner nutzt einen partiellen Index nur, wenn er die Implikation beweisen kann; mit identischer Liste klappt das auch bei der parametrisierten Form der App (`tags ->> $5 = ANY($6::text[])`).

## Messung (temporäre Kopie, nicht Prod)

Temp-Tabelle mit allen DE-Zeilen im 40-km-Umkreis von Karlsruhe (1,0 Mio. Zeilen), Abfrage per `PREPARE`/`EXECUTE` wie `node-pg`:

| Abfrage | ohne | mit partiellem Index |
|---|---|---|
| railway 15 km | 807 ms | **2,4 ms** |
| place 30 km | – | **7,5 ms** |

## Nachtrag 2026-10-22: Index 3 für die Fernverkehrs-Prüfung

Nach Index 1 und 2 brach die Bahnhofs-Kategorie weiter nach 12 s ab (6× in den ersten 1,5 h, z. B. kip Hamburg und bg-alo Sofia). Der Bahnhofs-Scan selbst nutzt Index 1 und dauert 25 ms. Teuer ist die `attachLongDistanceTrainRoute`-Prüfung, die je Bahnhof nach einer Fernverkehrs-Zugroute im 250-m-Umkreis sucht: der Planner kombiniert dafür per `BitmapAnd` den breiten Geo-Index mit dem Primärschlüssel-Index über **alle** Relationen des Landes (DE: 164 442). `EXPLAIN ANALYZE` (Hamburg, Prod): 73 ms × 155 Bahnhöfe = **11,4 s**.

In `osm_local_elements` gibt es für DE genau **eine** Relation mit `type=route` und `route=train`; der Import übernimmt Routen-Relationen kaum. Ein partieller Index nur auf diesen Zeilen ist deshalb winzig, und die Prädikate stehen wörtlich in der Abfrage:

```sql
CREATE INDEX CONCURRENTLY idx_osm_local_elements_geog_train_route
  ON osm_local_elements USING gist ((geom::geography))
  WHERE osm_type = 'relation' AND (tags ->> 'type') = 'route' AND (tags ->> 'route') = 'train';
```

Prüfen: `indisvalid` für den neuen Index wie unten, danach die Hamburg-Abfrage erneut mit `EXPLAIN ANALYZE`; der SubPlan muss `idx_osm_local_elements_geog_train_route` nutzen. Der bestehende Check für Index 1 und 2 bleibt davon getrennt, weil Index 3 zu diesem Zeitpunkt noch nicht angelegt ist.

Offen, unabhängig davon: Mit einer einzigen Zugroute in DE setzt die Prüfung `immo:long_distance_train_route` praktisch nie. Ob der OSM-Import Routen-Relationen mitnehmen soll, ist eine Frage an den Import-Job (ansible), nicht an diese Abfrage.

## Nicht gelöst

Dieselbe Technik für `amenity` (Fähre, Hochschule), `route=ferry` und `aeroway` brachte im Test nichts: der Planner blieb beim breiten Index, weil die Zeilenschätzung durch die zusätzlichen Index-Statistiken zu niedrig ausfiel. Diese Abfragen sind einzeln 0,1–0,7 s und nur unter Last langsam; nach den zwei Indizes zuerst im Log nachsehen, ob noch Timeouts bleiben.

## Ausführung

Siehe [2026-08-04-gis-wp1-index-notfall.md](2026-08-04-gis-wp1-index-notfall.md): **eine Session, nicht parallelisieren, off-peak**, kein Ad-hoc-Container (Connection-Erschöpfung hat am 2026-08-03 einen Prod-Ausfall verursacht). `CREATE INDEX CONCURRENTLY` scannt die Tabelle zweimal pro Index und kann auf bestehende Transaktionen warten; plane Zeit und Last entsprechend ein. Schreibzugriffe (osm2pgsql-Job) bleiben möglich.

Danach prüfen, dass beide Indizes valide sind (der Schritt, der 2026-08 übersprungen wurde):

```sql
SELECT count(*) = 2 AS all_expected_indexes_present,
       bool_and(indisvalid) AS all_valid
FROM pg_index
WHERE indrelid = 'osm_local_elements'::regclass
  AND indexrelid::regclass::text IN (
    'idx_osm_local_elements_geog_railway_station',
    'idx_osm_local_elements_geog_place'
  );
-- muss `true | true` liefern
```

Nach dem Anlegen von Index 3 separat prüfen:

```sql
SELECT indexrelid::regclass AS index_name, indisvalid
FROM pg_index
WHERE indrelid = 'osm_local_elements'::regclass
  AND indexrelid::regclass::text = 'idx_osm_local_elements_geog_train_route';
-- muss genau eine Zeile mit `t` liefern
```

Wirkung: `podman logs zvg-immo | grep '\[osm-context\]'` nach dem nächsten External-Enrichment-Lauf. Erwartung: kein `railway=…@15000m` und `place=…@30000m` mehr unter den langsamsten Kategorien, keine `Query read timeout` für die zvbawu-Auktionen.

Rückbau: `DROP INDEX CONCURRENTLY idx_osm_local_elements_geog_railway_station;` danach `DROP INDEX CONCURRENTLY idx_osm_local_elements_geog_place;` und ggf. `DROP INDEX CONCURRENTLY idx_osm_local_elements_geog_train_route;` (Schema-Drift beachten: Indizes zusätzlich in `server/db/schema.sql` nachtragen, falls dieser Stand dort gepflegt wird).
