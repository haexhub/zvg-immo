# WP-1 — Notfall: invalide Indizes und Query-Schutz

Datum: 2026-08-04
Teil von [GIS-Architektur](2026-08-04-gis-scaling-architecture.md). Abhängig von: nichts. **Zuerst umsetzen.**
Aufwand: ½–1 Tag. Repo: `zvg-immo`.

> **Bei Schema-Neuaufbau ([WP-0](2026-08-04-gis-wp0-schema-neuaufbau.md)) schrumpft dieses WP auf Schritt 3 und 4.** Die invaliden Indizes und der Schema-Drift verschwinden dann per Definition — Schritt 1 und 2 entfallen. Schritt 3 (`statement_timeout`) und Schritt 4 (Invalid-Index-Wächter) bleiben in jedem Fall nötig: ein neu aufgebautes Schema schützt nicht davor, dass eine künftige Query den Server wieder umlegt oder ein künftiges `CREATE INDEX CONCURRENTLY` erneut still scheitert. Aufwand dann ~2 Stunden.
>
> Der Rest dieses Dokuments bleibt als Beleg für die Ursache und als Fallback, falls WP-0 nicht umgesetzt wird.

## Warum

Die Umgebungssuche legt den Server lahm. Auf Prod gemessen (2026-08-04):

| Variante (ein einzelner Punkt, `LIMIT 1`) | Laufzeit |
|---|---|
| `nearSea` heute (4 Tag-Zweige) | **16 585 ms**, 13 GB gelesen |
| dieselbe Query ohne den `place`-Zweig | **560 ms** |
| `nearAirport` (`aeroway=aerodrome`) | **5 971 ms** |

Ursache: zwei Indizes auf `osm_local_elements` (44,5 Mio. Zeilen / 20 GB) sind **`indisvalid = false`**:

```
idx_osm_local_elements_geog       gist ((geom)::geography)     INVALID, 964 MB
idx_osm_local_elements_tag_place  btree ((tags ->> 'place'))   INVALID, 0 bytes
```

Postgres kann ein `BitmapOr` nur bauen, wenn **jeder** Zweig der OR-Kette einen nutzbaren Index hat. `nearSea` prüft `natural`, `water` **und** `place` ([auction-search-filters.ts:27-39](server/utils/auction-search-filters.ts#L27-L39)); weil der `place`-Zweig keinen validen Index hat, fällt die *gesamte* Kette auf einen Seq Scan über 20 GB zurück. Ein kaputter Index kostet also Faktor 30.

Zusätzlich: `idx_osm_local_elements_geom` (GIST auf `geom`, 1 988 MB) hat **0 Scans** — die Queries prädizieren auf `geom::geography`, worauf ein Index auf `geom` nicht passt. Der dafür gedachte `_geog`-Index ist genau der invalide.

Und: **keiner der `tag_*`/`_geog`-Indizes steht in [schema.sql](server/db/schema.sql)** — sie wurden manuell auf Prod angelegt, zwei `CREATE INDEX CONCURRENTLY` sind fehlgeschlagen, unbemerkt. Prod und Repo sind auseinandergelaufen.

## Ziel

1. Alle für die Umgebungsfilter nötigen Indizes sind valide und stehen im Repo-Schema.
2. Eine einzelne Suchanfrage kann den Server nicht mehr lahmlegen.
3. Ein künftiger Index-Drift fällt auf, statt monatelang unentdeckt zu bleiben.

## Schritte

### 1. Indizes auf Prod reparieren

Zuerst den Ist-Zustand bestätigen:

```sql
SELECT indexrelid::regclass, indisvalid, pg_size_pretty(pg_relation_size(indexrelid))
FROM pg_index WHERE indrelid = 'osm_local_elements'::regclass ORDER BY indisvalid;
```

Invalide Indizes müssen **gedroppt und neu gebaut** werden (`REINDEX` auf einem invaliden Index aus fehlgeschlagenem `CONCURRENTLY` ist nicht der verlässliche Weg):

```sql
DROP INDEX CONCURRENTLY IF EXISTS idx_osm_local_elements_tag_place;
CREATE INDEX CONCURRENTLY idx_osm_local_elements_tag_place
  ON osm_local_elements ((tags ->> 'place'));

-- aeroway fehlt komplett -> nearAirport läuft im Seq Scan (5 971 ms gemessen)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_osm_local_elements_tag_aeroway
  ON osm_local_elements ((tags ->> 'aeroway'));
```

Zum `_geog`-Index (964 MB, invalide): **nicht** neu bauen. Er wird nach WP-4/WP-5 nicht mehr gebraucht, weil `geo_features` in EPSG:3035 ohne Cast arbeitet. Ein Neubau kostet auf 44,5 Mio. Zeilen viel Zeit und I/O für einen Index mit begrenzter Restlebensdauer. Stattdessen droppen — er ist ohnehin wirkungslos und wird bei jedem Schreibzugriff mitgepflegt:

```sql
DROP INDEX CONCURRENTLY IF EXISTS idx_osm_local_elements_geog;
```

`idx_osm_local_elements_geom` (1 988 MB, 0 Scans) ist valide, aber unbenutzt. **Vorerst stehen lassen** — er ist die Grundlage für den KNN-Aufbau in WP-4. Erst nach WP-5 bewerten.

Nach jedem `CREATE INDEX CONCURRENTLY` prüfen, dass er *diesmal* valide ist — genau dieser Schritt wurde beim letzten Mal übersprungen:

```sql
SELECT indexrelid::regclass, indisvalid FROM pg_index
WHERE indrelid = 'osm_local_elements'::regclass AND NOT indisvalid;
-- muss 0 Zeilen liefern
```

**Achtung:** `CREATE INDEX CONCURRENTLY` läuft nicht in einer Transaktion und dauert auf dieser Tabelle Minuten. Off-peak ausführen. Ein Ad-hoc-Container hat am 2026-08-03 durch Connection-Erschöpfung einen Prod-Totalausfall verursacht — hier gilt dasselbe: eine Session, nicht parallelisieren.

### 2. Schema-Drift beheben

Alle auf Prod vorhandenen Indizes in [schema.sql](server/db/schema.sql) nachtragen, damit ein frischer Aufbau denselben Zustand erzeugt. Fehlen dort derzeit: `idx_osm_local_elements_tag_natural`, `_tag_waterway`, `_tag_water`, `_tag_place`, `_tag_aeroway`.

Das ist ein Übergangsschritt — ab WP-2 gehört Schemaarbeit in Drizzle-Migrationen.

### 3. `statement_timeout` auf den Such-Endpoints

Der wichtigste Punkt dieses WP, unabhängig von allem anderen: **eine Suchanfrage darf nicht die Fähigkeit haben, den Server umzulegen.** Auch nach WP-5 bleibt das die Versicherung gegen die nächste, noch unbekannte teure Query.

Betrifft [auctions.get.ts](server/api/auctions.get.ts) und [auctions-geo.get.ts](server/api/auctions-geo.get.ts). Beide holen ihre Connection über `getPool()` ([db.ts](server/utils/db.ts)).

Umsetzung: pro Request eine Connection aus dem Pool nehmen, `SET LOCAL statement_timeout` in einer Transaktion setzen, Query darauf ausführen. `SET LOCAL` (nicht `SET`) ist wichtig — eine gepoolte Connection behält ein globales `SET` sonst für alle nachfolgenden Nutzer.

Bei Timeout wirft `pg` einen Fehler mit `code === '57014'` (`query_canceled`). Den in einen `createError({ statusCode: 503 })` mit verständlicher Meldung übersetzen, statt einen 500er durchzulassen — das UI soll „Suche zu aufwendig, bitte Filter einschränken" zeigen können.

Richtwert: 10 s. Hoch genug für legitime Suchen, weit unter dem, was den Server umbringt.

### 4. Invalid-Index-Wächter

Damit der nächste Drift auffällt, den Check in die bestehende Health-Route aufnehmen ([server/api/_health](server/api/_health)):

```sql
SELECT indexrelid::regclass::text FROM pg_index WHERE NOT indisvalid;
```

Nicht-leeres Ergebnis → Health-Warnung mit Indexnamen. Billig (nur Katalog) und hätte dieses Problem sofort sichtbar gemacht.

Der `import.sh`-Job im ansible-Repo protokolliert denselben Check bereits nach jedem Lauf (siehe [WP-6](2026-08-04-gis-wp6-osm-datenausbau.md)).

## Verifikation

1. `SELECT … FROM pg_index WHERE NOT indisvalid` liefert 0 Zeilen.
2. Die `nearSea`-Messung wiederholen und mit den 16 585 ms vergleichen — erwartet werden ~500–600 ms:

```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT 1 FROM osm_local_elements o
WHERE (o.tags->>'natural'='coastline' OR o.tags->>'natural'='beach'
    OR o.tags->>'water'='sea' OR o.tags->>'place'='sea')
  AND ST_DWithin(o.geom::geography, ST_MakePoint(10.0,54.3)::geography, 5000)
LIMIT 1;
```
Im Plan muss `BitmapOr` statt `Parallel Seq Scan` stehen.
3. `nearAirport` analog prüfen (erwartet: Bitmap Index Scan statt der 5 971 ms).
4. Ein künstlich teurer Request gegen `/api/auctions` endet mit 503 statt Serverstillstand.
5. Health-Route meldet einen absichtlich invalidierten Index.

## Fallstricke

- **`REINDEX` statt DROP+CREATE** bei einem invaliden `CONCURRENTLY`-Index: nicht verlässlich, kann den invaliden Zustand behalten.
- **Validität nach dem Build nicht geprüft** — genau der Fehler, der zu diesem WP geführt hat.
- **`SET` statt `SET LOCAL`**: verseucht gepoolte Connections dauerhaft.
- **Reihenfolge:** Dieses WP muss vor [WP-3](2026-08-04-gis-wp3-geocoding-abdeckung.md) (Geocoding) fertig sein. Heute haben nur 37 von 3 720 Auktionen Koordinaten; steigt das auf die 2 785 mit Adresse, wächst die Last derselben Query um Faktor 75.
- Dies ist ein Pflaster, kein Fix. Der eigentliche Umbau ist [WP-5](2026-08-04-gis-wp5-precompute-suche.md).
