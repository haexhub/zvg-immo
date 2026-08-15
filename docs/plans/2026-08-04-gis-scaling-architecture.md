# GIS-Architektur für skalierende Lage- und Umgebungssuche

Datum: 2026-08-04
Umfang: Umbau der Umgebungs-/Geofilter von Live-Geometrie-Queries auf einen vorberechneten Metrik-Layer, plus Ausbau auf Tourismus- und Klimadaten. Schema und Migrationen künftig über Drizzle.

Implementierungspläne (je eine Session): [WP-0](2026-08-04-gis-wp0-schema-neuaufbau.md) · [WP-1](2026-08-04-gis-wp1-index-notfall.md) · [WP-2](2026-08-04-gis-wp2-drizzle-fundament.md) · [WP-3](2026-08-04-gis-wp3-geocoding-abdeckung.md) · [WP-4](2026-08-04-gis-wp4-geo-features.md) · [WP-5](2026-08-04-gis-wp5-precompute-suche.md) · [WP-6](2026-08-04-gis-wp6-osm-datenausbau.md) · [WP-7](2026-08-04-gis-wp7-klima-grid.md) · [WP-8](2026-08-04-gis-wp8-lagebeschreibung.md)

> **Nachtrag 2026-08-04:** Der Nutzer hat den vollständigen Neuaufbau von Schema und Daten freigegeben. Damit gilt **[WP-0](2026-08-04-gis-wp0-schema-neuaufbau.md) statt [WP-2](2026-08-04-gis-wp2-drizzle-fundament.md)**, und [WP-1](2026-08-04-gis-wp1-index-notfall.md) schrumpft auf `statement_timeout` und den Invalid-Index-Wächter. Der Gewinn liegt fast vollständig bei Drizzle: der Baseline-Kompromiss (zwei Wahrheiten über dasselbe Schema) entfällt, und das Serving-Modell kann direkt richtig entstehen — Koordinaten auf `auctions` statt versioniert, `is_latest` statt `LATERAL`-Join, EPSG:3035 direkt beim Import. Alles Übrige unten bleibt unverändert gültig.

> **Status 2026-08-05: WP-0, WP-1 und WP-4 sind erledigt.** WP-0 (PR #313) hat Prod hart zurückgesetzt und neu migriert; WP-1 (PR #312) läuft (`statement_timeout` + Invalid-Index-Wächter unter [/api/_health/db](../../server/api/_health/db.get.ts)). `geo_features`, `auction_geo_metrics` und `climate_cells` existieren bereits als Skeleton-Tabellen samt PostGIS-`customType` in [server/db/schema/geo.ts](../../server/db/schema/geo.ts) — [WP-4](2026-08-04-gis-wp4-geo-features.md) (PR #318) befüllt `geo_features` per `server/tasks/build-geo-features.ts`, gegen echtes Postgres verifiziert (Kind-Mapping, Lake/River-Ausschluss, Idempotenz, KNN-Index-Nutzung). Auf Prod noch nicht gelaufen: `osm_local_elements` ist dort seit dem WP-0-Neuaufbau leer (0 Zeilen, 168 MB Gesamt-DB-Größe statt der ursprünglichen 20 GB), der externe osm2pgsql-Reimport steht noch aus. RLS wurde nachträglich gegen Prod verifiziert: 0 Anwendungstabellen ohne RLS (die einzige Tabelle ohne RLS ist `spatial_ref_sys`, eine PostGIS-Systemtabelle, kein Anwendungsschema).
>
> Der Reset hat drei Folgefehler produziert, die **nicht** Teil von WP-0 selbst waren, sondern seiner Grundannahme "Koordinaten auf `auctions`" nicht konsequent genug nachgeführt wurden bzw. Nebenwirkungen des Hard-Resets waren — Details in Memory `wp0-rebuild-aftermath-cascade`:
> 1. Vier Stellen lasen noch `d.lat`/`d.lng` statt `a.lat`/`a.lng` → 500er auf Geo-Endpunkten (Fix: PR #314).
> 2. `auction_details`-INSERT versuchte weiterhin `lat`/`lng` zu schreiben (Spalte existiert dort nicht mehr) → **jeder** Schreibvorgang scheiterte, Tabelle blieb leer; zusätzlich fehlte das Schreiben von `lat`/`lng` nach `auctions` in `current-auctions.ts`, und `auction_details.is_latest` wurde nie demotet (Fix: PR #315, nur durch echtes Postgres-Testen gefunden, nicht durch Mocks).
> 3. `app_settings` wurde durch den Reset geleert → Default `hide_rules_only_auctions = true` blendete alle Auktionen aus, solange keine LLM-Analyse vorliegt (Fix: Admin-Setting manuell auf `false` gestellt).
>
> **Aktuelle Messung (2026-08-05):** Geocoding-Abdeckung DE **2 357/2 685 (88 %)**, deutlich über dem 1 %-Ausgangswert aus der Messung unten — SE weiterhin **0/96**, ungeklärt (siehe [WP-3](2026-08-04-gis-wp3-geocoding-abdeckung.md)). **LLM-Extraktion ist aktuell nicht funktionsfähig** (Provider/Config muss neu aufgebaut werden) — bis dahin liefert `reprocess` nur regelbasierte Extraktionen; `hide_rules_only_auctions` muss auf `false` bleiben, sonst verschwindet die Suche wieder vollständig. Offen und **vor Welle 2 einzuplanen**: ein NUL-Byte-Encoding-Fehler im de/bw-Crawler (`server/crawlers/zvbawu/`), der Crawls dieser Region scheitern lässt — vermutlich vorbestehend, noch nicht gefixt.

## Ziel

Zwei Klassen von Fragen sollen europaweit in Millisekunden beantwortbar sein:

1. **Schwellenwert-Suche** – „Grundstücke ≤ 5 km zum Meer **und** ≤ 50 km zum nächsten Skigebiet", „Sommer-Durchschnittstemperatur ≤ 30 °C".
2. **Lagebeschreibung pro Objekt** – „nächstes Skigebiet 23 km, Badesee 1,8 km, Meer 140 km, Wanderwegnetz angrenzend, Angeln möglich, 3 Sehenswürdigkeiten im Umkreis".

Beides ist derselbe Datenbedarf: **die Entfernung zum nächsten Element je Kategorie, als Zahl pro Auktion.** Die heutige Architektur beantwortet nur (1), und zwar extrem teuer; wenn man stattdessen (2) speichert, fällt (1) als reiner Zahlenvergleich heraus.

## Messung auf Prod (2026-08-04)

Alle Zahlen direkt gegen `zvg-immo-supabase-db` (PostgreSQL 17.6) erhoben.

| Tabelle | Zeilen | Größe |
|---|---|---|
| `osm_local_elements` | **44 479 427** | **20 GB** (6,9 GB Indizes) |
| `auctions` | 3 720 | 4,2 MB |
| `auction_details` | 3 847 | 4,2 MB |

**Verteilung in `osm_local_elements`** (Sampling `TABLESAMPLE SYSTEM (0.2)`): **90,1 % sind `building`** — extrapoliert ~40 Mio. Zeilen. `highway` 4,3 %, `natural` 1,2 %, `place` 0,26 %, `waterway` 0,08 %. Nach Land: DE 43 491 674, BG 1 039 402, **SE 0 — Schweden ist nie importiert worden**, obwohl es in `COUNTRY_RAIL_CODES` steht.

**Geocoding-Abdeckung:** 2 785 Auktionen haben eine Adresse, aber nur **37 haben Koordinaten** (1,0 %). Nach Land: DE 37/3 275, BG 0/348, SE 0/97. Jeder Geofilter kann derzeit also höchstens 37 Objekte treffen.

### Der Query-Plan

`EXPLAIN` der `nearSea`-Suche über alle Länder:

```
Nested Loop Semi Join  (cost=1000.28..42278575366.78 rows=4)
  Join Filter: st_dwithin((o.geom)::geography, st_makepoint(d.lng, d.lat)::geography, 5000)
  ->  Nested Loop (rows=3720)  [auctions × LATERAL auction_details]
  ->  Materialize  (rows=452035 width=140)
        ->  Parallel Seq Scan on osm_local_elements o
              Filter: tags->>'natural' = 'coastline' OR ... OR tags->>'place' = 'sea'
```

**42,3 Milliarden** Kosteneinheiten. `ST_DWithin` läuft als **Join-Filter** über 452 035 materialisierte Zeilen — pro Auktion.

Gemessen für einen *einzelnen* Punkt (`LIMIT 1`, also mit Early-Exit):

| Variante | Laufzeit | Plan |
|---|---|---|
| Ist-Zustand `nearSea` (4 Tag-Zweige) | **16 585 ms** | Parallel Seq Scan, 13 GB gelesen |
| dieselbe Query ohne den `place`-Zweig | **560 ms** | `BitmapOr` über 3 Indizes |
| ein Tag + KNN (`<->`) | **147 ms** | Bitmap Index Scan |
| `nearAirport` (`aeroway=aerodrome`) | **5 971 ms** | Parallel Seq Scan (kein Index) |

Bei 37 geocodierten Auktionen × 16,6 s ist eine Suchanfrage rund **10 Minuten** Volllast — das erklärt den Serverausfall vollständig.

### Die eigentliche Ursache

Zwei Indizes auf `osm_local_elements` sind **`indisvalid = false`**:

```
idx_osm_local_elements_geog       gist ((geom)::geography)        INVALID, 964 MB
idx_osm_local_elements_tag_place  btree ((tags ->> 'place'))      INVALID, 0 bytes
```

Ein invalider Index wird vom Planner ignoriert, belegt aber Platz und wird bei DML weiter gepflegt. Die Folge ist überproportional: Postgres kann ein `BitmapOr` nur bauen, wenn **jeder** Zweig der OR-Kette einen nutzbaren Index hat. Der `place`-Zweig hat keinen — also fällt die **gesamte** Kette auf einen Seq Scan über 20 GB zurück. Das ist der Unterschied zwischen 560 ms und 16 585 ms, verursacht von einem einzigen kaputten Index.

Zusätzlich ist `idx_osm_local_elements_geom` (GIST auf `geom`, 1 988 MB) mit **0 Scans** komplett unbenutzt: die Queries prädizieren auf `geom::geography`, und ein Index auf `geom` passt darauf nicht. Der dafür gedachte `_geog`-Index ist genau der invalide.

**Und: keiner der `tag_*`- und `_geog`-Indizes steht in [schema.sql](server/db/schema.sql).** Sie wurden manuell auf Prod angelegt — vermutlich als Reaktion auf genau dieses Problem, wobei zwei `CREATE INDEX CONCURRENTLY` fehlgeschlagen sind, ohne dass es jemand bemerkte. Prod und Repo-Schema sind auseinandergelaufen.

Das ist das Argument für den Umstieg auf Migrationen ([WP-0](2026-08-04-gis-wp0-schema-neuaufbau.md)) — allerdings mit einer Präzisierung, die wichtig ist: **Migrationen verhindern, dass so ein Zustand entsteht, sie erkennen ihn nicht.** Auch Drizzle prüft nur seine eigene Migrationstabelle, nicht den Ist-Zustand der Datenbank; ein manuell angelegter oder fehlgeschlagener Index bleibt genauso unsichtbar wie heute. Erkennung braucht einen aktiven Vergleich: den `indisvalid`-Wächter aus [WP-1](2026-08-04-gis-wp1-index-notfall.md) und einen Schema-Diff gegen die laufende Datenbank. Beides ist nötig, nicht eines davon.

Verstärkend, aber nicht ursächlich: `LATEST_DETAILS_JOIN_SQL` ist ein `LEFT JOIN LATERAL … LIMIT 1` ([auctions.get.ts:74-78](server/api/auctions.get.ts#L74-L78)), also ein Nested Loop pro Auktionszeile, und `/api/auctions` wertet dasselbe Prädikat dreimal aus (Seite, Count, Facetten).

### Was das für die Reihenfolge bedeutet

Der wichtigste Befund der Messung ist eine **Reihenfolge-Abhängigkeit, die vorher nicht sichtbar war**: Die Geo-Suche wirkt heute nur auf 37 Objekte. Wird das Geocoding repariert (2 785 Auktionen haben eine Adresse), steigt die Last derselben Query um **Faktor 75**. Geocoding vor dem Query-Fix zu reparieren, würde den Ausfall also massiv verschärfen. WP-3 darf erst nach WP-1 laufen.

## Architektur

Die Lösung ist eine strikte Trennung: **Geometrie wird im Batch verarbeitet, die Suche sieht nur noch Zahlen.**

```
OSM-Extrakte ──osm2pgsql──> osm_local_elements     (Rohdaten, unverändert)
                                   │
                            Normalisierung (SQL)
                                   ▼
                             geo_features           Schicht 1: query-fertige POIs
                          (kind, geom_3035)         projiziert + zerlegt
                                   │
                          Nachtjob: KNN-Distanz
                                   ▼
                        auction_geo_metrics         Schicht 2: eine Zahlenzeile
                     (dist_sea_m, dist_ski_m, …)    pro Auktion
                                   │
                            ┌──────┴──────┐
                            ▼             ▼
                      Suche (Zahlen-   Lagebeschreibung
                       vergleich)      (Detailseite)

climate_cells (Raster-Grid) ──── per climate_cell_id angejoint
```

Zwei Datenklassen, zwei Verfahren — das ist der Kern:

| | diskrete Objekte (Meer, See, Skigebiet, Wanderweg) | kontinuierliche Felder (Klima, Luftqualität) |
|---|---|---|
| Frage | „wie weit zum nächsten?" | „welcher Wert gilt hier?" |
| Verfahren | Distanz pro Auktion vorberechnen | Grid-Zelle pro Auktion, Werte am Grid |
| Kosten | skaliert mit Auktionen | skaliert **nicht** mit Auktionen |

Für Klima ist das entscheidend: Klimanormale sind auf 9 km Raster definiert. Es wäre Verschwendung, sie pro Auktion abzurufen — Europa hat bei 0,1° etwa 150 000 Zellen, und dieser Aufwand bleibt gleich, ob 3 720 oder 5 Mio. Auktionen im System sind.

### Schicht 1 — `geo_features`

Normalisierter, query-fertiger POI-Layer, aufgebaut aus `osm_local_elements` (kein neuer Import). Drei bewusste Entscheidungen:

**EPSG:3035 statt 4326.** ETRS89-LAEA ist der INSPIRE-Standard für Europa und rechnet in Metern. Damit liefert der KNN-Operator `<->` direkt Meter *und* nutzt den GIST-Index — kein `::geography`-Cast, also kein toter Index wie heute. Die LAEA-Verzerrung ist für „nächstes Skigebiet in km" irrelevant; wo es auf den Meter ankommt, rechnet der Job mit `ST_Distance(…::geography)` nach.

**Geometrien werden zerlegt.** `ST_Subdivide(geom, 128)` schneidet Küstenlinien, Flüsse und große Flächen in Stücke mit kleinen Bounding Boxes. Ein `natural=coastline`-Way kann hunderte Kilometer lang sein; seine Bounding Box umspannt dann halbe Länder, wodurch ein Geo-Index kaum etwas ausschließt. Das erklärt auch den Rest der 560 ms in der Messung oben: dort las der Bitmap-Pfad noch 6 686 Buffer, weil `ST_DWithin` auf ganzen Küstenlinien-Geometrien arbeitet.

**`kind` statt Roh-Tags.** Die OSM-Tag-Logik („Meer ist coastline *oder* beach *oder* bay *oder* …") wird einmal beim Aufbau angewandt statt bei jeder Query. Damit verschwindet die OR-Ketten-Fragilität, die heute die Ursache ist: keine `jsonb`-Ausdrücke, kein `BitmapOr`, dessen Zusammenbruch von einem einzelnen Index abhängt.

Nur ~10 % der heutigen Tabelle sind für diesen Layer überhaupt relevant — `building` (90 %) wird nicht übernommen.

### Schicht 2 — `auction_geo_metrics`

Eine breite Zeile pro Auktion mit Distanzen in Metern je Kategorie plus Namen für die Lagebeschreibung.

**Eine breite Zeile, nicht `(auktion, kind, distanz)`.** Die Suche verknüpft mit AND: `dist_sea_m <= 5000 AND dist_ski_m <= 50000` ist damit ein Zeilenfilter statt zweier Semi-Joins mit Aggregation. Sortierung („nächste am Meer zuerst") wird trivial, neue Kategorien sind ein additives `ADD COLUMN`.

**Warum das schnell ist, hat nichts mit Indizes zu tun.** Bei ~20 `int`-Spalten sind das ~100 Byte pro Auktion — heute 370 KB, bei einer Million Auktionen 100 MB, vollständig im Page-Cache. Ein Seq Scan darüber mit beliebig vielen numerischen Prädikaten kostet Millisekunden. Der Gewinn kommt nicht von besserer Indexierung, sondern davon, dass **zur Query-Zeit keine Geometrie mehr angefasst wird.**

**Distanz statt Boolean.** Der vorberechnete Meter-Wert beantwortet *jeden* Radius. Es braucht daher keinen Live-Fallback für „ungewöhnliche" Radien — genau daran scheitert der heutige Ansatz, der pro Radius neu rechnet.

**Cutoff und NULL-Semantik.** Je Kategorie wird nur bis zu einem Cutoff (z. B. 200 km) gerechnet. „nichts in Reichweite" muss von „noch nicht berechnet" unterscheidbar bleiben: fehlende Zeile heißt nicht berechnet, vorhandene Zeile mit `dist_ski_m IS NULL` heißt nichts innerhalb Cutoff. Diese Unterscheidung ist bei `locationContext: null` schon einmal verloren gegangen ([osm-location-context.ts:141-145](server/utils/external-data/osm-location-context.ts#L141-L145)).

**Der Cutoff begrenzt den suchbaren Radius — das muss im UI erzwungen werden.** Ein `NULL` bedeutet „weiter als der Cutoff", nicht „unbekannt". Fragt der Nutzer nach 300 km, während der Cutoff bei 200 km liegt, kann kein Prädikat auf der Spalte die Treffer zwischen 200 und 300 km finden: sie sind alle `NULL`, ununterscheidbar von „gar nichts in der Nähe". Ein `dist_ski_m <= 300000` würde sie stillschweigend ausschließen und der Filter wäre schlicht falsch.

Konsequenz, verbindlich für [WP-5](2026-08-04-gis-wp5-precompute-suche.md): **das Slider-Maximum je Kategorie ist der Cutoff dieser Kategorie**, nicht ein frei gewählter UI-Wert. Die Cutoffs gehören damit an eine Stelle, die Precompute-Job *und* Filter-Validierung lesen. Ein Radius über dem Cutoff wird abgewiesen, nicht stillschweigend gekappt. Wird ein Cutoff später erhöht, müssen alle Metriken neu berechnet werden — dafür ist `features_epoch` da.

Kernabfrage des Nachtjobs, pro Auktion und Kategorie:

```sql
SELECT f.name, ST_Distance(f.geom_3035, $point) AS dist_m
FROM geo_features f
WHERE f.kind = $kind
  AND ST_DWithin(f.geom_3035, $point, $cutoff_m)
ORDER BY f.geom_3035 <-> $point
LIMIT 1;
```

Bei 3 720 Auktionen × ~15 Kategorien sind das ~56 000 Lookups. **Die Laufzeit ist damit noch nicht abschätzbar** — die 147 ms der Messung oben sind die falsche Bezugsgröße, denn sie stammen von der Rohtabelle mit `::geography`-Cast und unzerlegten Küstenlinien. Sequenziell hochgerechnet wären es 137 Minuten; mit EPSG:3035, zerlegten Geometrien und einem `kind`-Subset statt 44,5 Mio. Zeilen ist ein Bruchteil davon zu erwarten, aber das ist eine Vermutung, keine Zahl.

Deshalb: In [WP-4](2026-08-04-gis-wp4-geo-features.md) wird die KNN-Abfrage gegen den fertigen Layer gemessen, und erst diese Zahl × 56 000 ergibt die Laufzeit. Parallelität ist durch das Connection-Limit des Jobs begrenzt (siehe WP-5), nicht durch die CPU. Im laufenden Betrieb betrifft der Job ohnehin nur neu geocodierte Auktionen.

### Schicht 3 — `climate_cells`

0,1°-Raster (ERA5-Land) mit Klimanormalen je Zelle; die Auktion trägt nur `climate_cell_id`. „Sommer-Durchschnittstemperatur ≤ 30 °C" wird damit ein Join auf eine kleine Tabelle.

Quelle: **Open-Meteo Historical Weather API** (`/v1/archive`, ERA5-Land, 9 km, keyless). Das Projekt spricht Open-Meteo für Luftqualität schon an ([cams-air-quality.ts:38](server/utils/external-data/cams-air-quality.ts#L38)) und hat mit `sources.ts` das Konfigurations-Framework dafür. Entscheidend fürs Volumen: **nur Zellen befüllen, in denen Auktionen liegen**, lazy beim ersten Bedarf. Details in [WP-7](2026-08-04-gis-wp7-klima-grid.md).

## Datenquellen für den Wunschkatalog

Alles Genannte ist in OSM vorhanden und über den bestehenden osm2pgsql-Lauf erreichbar — es fehlt nur im Tag-Filter. Drei strukturelle Lücken zuerst:

**Schweden ist nie importiert worden** (0 Zeilen). Alle SE-Geofilter und die SE-Landing-Rail sind damit funktionslos.

**Routen-Relationen werden vollständig verworfen.** [Der Lua-Filter nimmt nur `type=multipolygon`](../../ansible/roles/zvg-immo/files/osm-import/osm-local-elements.lua) — Wander-, MTB- und Kanurouten sind aber `type=route`-Relationen. Ohne Erweiterung auf `as_multilinestring()` ist der gesamte Freizeitwege-Block nicht abbildbar.

**`building` als „beliebiger Wert" dominiert die Tabelle** mit 90 % / ~40 Mio. Zeilen. Ihr Informationsgehalt für die Lagebewertung ist Bebauungsdichte — als Zahl pro Rasterzelle vorberechenbar, statt jedes Gebäude vorzuhalten. Nach dem Umbau kein Query-Problem mehr, aber weiter eines für Tabellengröße, Reimport-Dauer und Backups.

| Kategorie | OSM-Tags | Status |
|---|---|---|
| Skigebiet | `landuse=winter_sports`, `piste:type=downhill\|nordic`, `aerialway=gondola\|chair_lift\|cable_car\|drag_lift`, `site=piste` | neu |
| Badesee / Baden | `leisure=swimming_area`, `natural=water`+`sport=swimming`, `natural=beach`, `amenity=public_bath` | teilweise |
| Wandern | `route=hiking` (Relation), `highway=path`+`sac_scale`, `information=guidepost` | neu |
| Mountainbike | `route=mtb` (Relation), `mtb:scale=*`, `highway=path`+`mtb=yes` | neu |
| Kanu / Paddeln | `canoe=yes` auf `waterway`, `whitewater=*`, `leisure=slipway` | neu |
| Schifffahrt / Hafen | `leisure=marina`, `waterway=canal`, `mooring=*` | neu |
| Angeln | `leisure=fishing`, `sport=fishing`, `fishing=yes` | neu |
| Sehenswürdigkeiten | `tourism=attraction\|museum\|viewpoint\|theme_park\|zoo`, `historic=castle\|monument\|archaeological_site`, `heritage=*` | neu |
| Touristische Erschließung | `tourism=camp_site\|hotel\|guest_house\|apartment`, `leisure=golf_course\|water_park\|nature_reserve` | neu |
| Thermal / Wellness | `amenity=spa`, `bath:type=thermal` | neu |
| Meer / See / Fluss / Berg / Flughafen | vorhanden | vorhanden |

Zur touristischen Erschließung: die **Dichte** von `tourism=*`-Objekten im Umkreis ist der belastbarere Indikator als jede Einzeldistanz — sie misst, ob eine Gegend touristisch überhaupt erschlossen *ist*. Diese Zahl (Anzahl im Radius, nicht Distanz) gehört als eigene Spalte in Schicht 2.

Skigebiete sind der einzige Fall, wo OSM Vorsicht verlangt: sie sind [uneinheitlich erfasst](https://wiki.openstreetmap.org/wiki/Tag:landuse=winter_sports) — teils als `landuse=winter_sports`-Fläche, teils nur als Bündel von Pisten und Liften ohne Umrissfläche. Die Tag-Vereinigung oben ergibt trotzdem eine brauchbare `kind='ski_area'`-Menge; die Namensauflösung sollte von Fläche oder Aufstiegsanlage kommen, nicht von einer einzelnen Piste.

## Drizzle als Schema- und Zugriffsschicht

Heute: `pg`-Pool mit rohem SQL, und ein Bootstrap-Plugin wendet `schema.sql` bei **jedem Start** idempotent an ([db-bootstrap.ts](server/plugins/db-bootstrap.ts)). Das ist kein Migrationssystem: es prüft je Objekt nur „fehlt es?", nie „ist es so, wie es sein soll?" — ein von Hand hinzugefügter oder halb angelegter Index passiert es unbemerkt. Genau das ist der Anlass, jetzt umzustellen. Was Migrationen dabei leisten und was nicht, steht im Abschnitt oben: sie machen das Repo zur einzigen Quelle, ersetzen aber keinen Wächter.

Zwei Dinge, die den Zuschnitt bestimmen:

**Drizzle kann PostGIS nur teilweise nativ.** GIST-Indizes gehen deklarativ (`index().using('gist', table.geom)`), und `geometry({ type: 'point', srid: … })` ist eingebaut — aber nur für **Point**. `geo_features.geom_3035` ist `geometry(Geometry, 3035)` mit gemischten Typen, und `geography` [ist noch ein offener PR](https://github.com/drizzle-team/drizzle-orm/pull/3021). Beides braucht `customType`, rund 15 Zeilen. `ST_Subdivide`, `ST_DWithin` und der KNN-Operator `<->` bleiben `sql`-Template-Literale — Drizzle soll sie nicht abstrahieren.

**Kein Big-Bang.** `drizzle-kit pull` auf 952 Zeilen Schema mit RLS, Triggern und Functions liefert nichts Sauberes. Der Weg ist eine **Baseline**: bestehendes `schema.sql` bleibt der Ausgangszustand, Drizzle übernimmt ab jetzt für alles Neue und alle Änderungen. Die neuen Tabellen dieses Plans sind dafür der ideale erste Fall — sie sind flache Zahlentabellen, genau wo ein ORM trägt.

Details, Regeln und der bekannte Fallstrick mit dem Docker-Image in [WP-2](2026-08-04-gis-wp2-drizzle-fundament.md).

## Arbeitspakete

Jedes ist ein eigenständiges Dokument, in einer Session umsetzbar.

| WP | Inhalt | Aufwand | Abhängig von |
|---|---|---|---|
| [WP-0](2026-08-04-gis-wp0-schema-neuaufbau.md) | **Schema-Neuaufbau auf Drizzle** (Greenfield, `pg_dump` vorher) | 2–3 Tage | ✅ **erledigt** (PR #313 + Folgefixes #314/#315) |
| [WP-1](2026-08-04-gis-wp1-index-notfall.md) | `statement_timeout` + Invalid-Index-Wächter (Rest entfällt mit WP-0) | ~2 h | ✅ **erledigt** (PR #312) |
| ~~[WP-2](2026-08-04-gis-wp2-drizzle-fundament.md)~~ | ~~Drizzle mit Baseline~~ — **ersetzt durch WP-0**; PostGIS-`customType` und Docker-Fallstrick dort weiterverwenden | — | — |
| [WP-3](2026-08-04-gis-wp3-geocoding-abdeckung.md) | Geocoding-Abdeckung von 1 % anheben | 2–3 Tage | ✅ **erledigt** (PR #319) — SE-Root-Cause war ein Persistenzbug in `reprocess.ts`, nicht der Geocoder; LocationIQ-ENV auf Prod weiterhin offen (ansible-Folgeschritt) |
| [WP-4](2026-08-04-gis-wp4-geo-features.md) | `geo_features`-Layer (EPSG:3035, zerlegt, `kind`-Mapping) | 2–3 Tage | ✅ **erledigt** (PR #318) — Aufbau-Job läuft seitdem produktiv gegen echte OSM-Daten (Reimport-Bugs #321/ansible#88/ansible#91 gefixt, s. Status unten) |
| [WP-5](2026-08-04-gis-wp5-precompute-suche.md) | `auction_geo_metrics` + Suche umstellen ← **der eigentliche Fix** | 3–4 Tage | ✅ **erledigt** (PR #323, Cron-Wiring #339) — live gegen echte Daten verifiziert, seither zwei Nachbesserungen: verwaiste Zeilen bei Geocode-Verlust (PR #422), Statement-Timeout eines Kandidaten bricht nicht mehr den ganzen Lauf ab (PR #424) |
| [WP-6](2026-08-04-gis-wp6-osm-datenausbau.md) | Lua-Filter: SE nachziehen, Routen-Relationen, Ski/Tourismus-Tags | 1–2 Tage | ✅ **erledigt** ([ansible#87](https://github.com/haexhub/ansible/pull/87)) — Reimport lief nach zwei live gefundenen Bugs durch (PK-Kollision an Ländergrenzen → [zvg-immo#321](https://github.com/haexhub/zvg-immo/pull/321); `--flat-nodes` sprengte die Prod-Disk → `--slim --drop`, ansible#91); DE zuletzt manuell am 2026-08-07 erfolgreich reimportiert |
| [WP-7](2026-08-04-gis-wp7-klima-grid.md) | `climate_cells` + Open-Meteo-Adapter + Temperaturfilter | 2–3 Tage | 🟡 **teilweise** — Datenfundament + Detailseiten-Klimachart erledigt (PR #340, Transaktions-Fix #428); der Such-Filter-Teil (`summerTempMax`-Slider, `auction_geo_metrics.climateCellId`-FK) ist bewusst nicht angegangen |
| [WP-8](2026-08-04-gis-wp8-lagebeschreibung.md) | Lagebeschreibung und Scores für Wohnen / wirtschaftliche Nutzung | 2–3 Tage | ⬜ **nicht begonnen** — Eingangsdaten (`auction_geo_metrics`, `climate_cells`) liegen vor, **das ist der nächste offene Schritt der Serie** |

```
WP-1 (Timeout+Wächter) ──> WP-3 (Geocoding)   ← erst nach WP-1, sonst Faktor 75 mehr Last

WP-0 (Neuaufbau) ──> WP-4 (geo_features) ──> WP-5 (Precompute) ──┬─> WP-7 (Klima) ──> WP-8
                                              └─> WP-6 (OSM-Daten)
```

WP-0 und WP-1 sind unabhängig und können parallel laufen. WP-1 zuerst — es dauert zwei Stunden, und der `statement_timeout` schützt den Server auch während des Umbaus.

Ein Reimport der OSM-Daten fällt sowohl in WP-0 (Neuaufbau) als auch in WP-6 (neue Tags) an. **Nur einmal ausführen** — WP-6 vor dem Reimport deployen, dann beide Ziele mit einem Lauf erreichen. DE dauert mehrere Stunden.

> **Status 2026-08-05 (historisch, aufgelöst — siehe Status 2026-08-15 unten):** Der WP-0-Hard-Reset hat `osm_local_elements` mitgeleert (0 Zeilen, 96 kB statt der ursprünglichen 44,5 Mio. Zeilen/20 GB, verifiziert per `pg_stat_user_tables`) — der Reimport wurde seither nicht nachgeholt. WP-4s Aufbau-Job (PR #318) ist gemergt und lokal verifiziert, **auf Prod aber noch nicht gelaufen** — ein Lauf gegen die leere Quelle würde `geo_features` heute mit nichts befüllen. WP-5 hat noch nicht begonnen, es hängt an denselben Daten. WP-6s Code liegt bereits vor ([ansible#87](https://github.com/haexhub/ansible/pull/87), Branch `osm-import-geo-features`), aber nur syntaktisch geprüft, nicht gegen einen echten osm2pgsql-Lauf. Reihenfolge ab hier: ansible#87 gegen einen kleinen Extrakt (Bulgarien, nicht DE) testen, reviewen, mergen, deployen → DE/SE/BG-Reimport auslösen (mehrere Stunden, hohe Prod-Last, erfordert explizite Freigabe) → WP-4-Aufbau-Job auf Prod ausführen → WP-5-Precompute starten.

> **Status 2026-08-15: Blocker aufgelöst, WP-0 bis WP-6 erledigt.** Der Reimport lief durch — auf dem Weg zwei weitere, unabhängige Live-Bugs gefunden und gefixt: eine PK-Kollision an Länder-Grenzextrakten killte den ganzen Swap eines Landes ([zvg-immo#321](https://github.com/haexhub/zvg-immo/pull/321)), und `osm2pgsql --flat-nodes` sprengte mit ~100-120GB pro Land die Prod-Disk (Fix: `--slim --drop`, [ansible#91](https://github.com/haexhub/ansible/pull/91)). WP-4/WP-5 liefen danach produktiv gegen echte Daten; zwei Nachbesserungen seither (PR #422, PR #424, siehe Tabelle oben) laufen jetzt stabil im nächtlichen Cron. WP-7 ist nur zur Hälfte erledigt: die Datengrundlage (`climate_cells`) und der Klimachart auf der Objekt-Detailseite existieren (PR #340), der Such-Filter-Teil bewusst nicht. **WP-8 wurde noch nicht begonnen** — seine Eingangsdaten (`auction_geo_metrics` aus WP-5, `climate_cells` aus WP-7) liegen vollständig vor, das ist damit der nächste offene Schritt dieser Planserie.

## Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| **Neuaufbau verliert Zeitreihen** — `auction_observations` (19 582) und `artifact_captures` (65 104) sind Beobachtungen über Zeit und nicht durch einen neuen Crawl wiederherstellbar; derselbe Verlust war schon einmal ein behandelter Vorfall (PR #220) | `pg_dump` vor dem Drop, geprüft wiederherstellbar (WP-0) |
| **Geocode-Cache liegt im Dateisystem**, nicht in der DB — ~18 400 Auflösungen ≈ 5,6 h Nominatim-Arbeit, wegen IP-Ban nicht schnell nachholbar | `/app/.cache_zvg/geocode` separat sichern, nicht mit aufräumen (WP-0) |
| Geocoding-Fix ohne Query-Fix → 75× mehr Last | WP-3 strikt nach WP-1 |
| Precompute-Job erschöpft Connections wie der OSM-Reimport am 2026-08-03 | eigener Pool mit hartem Limit, Batch-Commits, off-peak |
| Weiterer stiller Index-Drift auf Prod | `indisvalid`-Wächter in die Health-Route (WP-1) — Migrationen ab WP-0 verhindern Drift, erkennen ihn aber nicht |
| Veraltete Metriken nach OSM-Reimport oder Neu-Geocoding | `features_epoch` + `point_hash` als Invalidierungsschlüssel, im Schema von Anfang an |
| „nichts in Reichweite" nicht von „nicht berechnet" unterscheidbar | getrennt modelliert: fehlende Zeile vs. Spalte `IS NULL` |
| `ST_Subdivide` vergrößert die Tabelle | in WP-4 messen; nur Linien und große Flächen zerlegen, keine Punkte |
| Skigebiete in OSM lückenhaft | Tag-Vereinigung aus Fläche + Piste + Lift; Abdeckung je Land in WP-6 stichprobenartig prüfen |
| Cutoff schneidet legitime Treffer ab | Cutoff je Kategorie; im UI „> 200 km" statt „keine Angabe" |

## Was dieser Plan nicht vorschlägt

- **Kein PostGIS-Ersatz, keine separate Geo-Datenbank.** Das Problem ist nicht Postgres — es ist ein kaputter Index und Geometrie im Anfragepfad. Nach dem Umbau ist die Suche eine gewöhnliche numerische Abfrage.
- **Kein Result-Cache als Lösung.** Ein Cache würde das Problem verdecken und beim ersten Miss auf einem ungewöhnlichen Filter wieder aufreißen.
- **Keine Vorberechnung pro Radius.** Distanzen statt Booleans beantworten jeden Radius mit derselben Zeile.
- **Kein vollständiger Drizzle-Rewrite.** Baseline statt Big-Bang; bestehende Roh-SQL-Aufrufe bleiben, bis ein Grund besteht, sie anzufassen.
