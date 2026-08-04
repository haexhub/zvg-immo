# WP-0 — Schema-Neuaufbau auf Drizzle (Greenfield)

Datum: 2026-08-04
Teil von [GIS-Architektur](2026-08-04-gis-scaling-architecture.md). Abhängig von: nichts. **Ersetzt den Baseline-Ansatz in WP-2 und verkleinert WP-1.**
Aufwand: 2–3 Tage. Repo: `zvg-immo`.

## Entscheidung

Datenbank und Schema werden vollständig verworfen und aus Drizzle neu aufgebaut. Der Nutzer hat das ausdrücklich freigegeben mit der Begründung, dass die Daten wiederbeschaffbar sind.

## Was das vereinfacht

**Drizzle wird sauber statt kompromissbehaftet.** Der Baseline-Ansatz aus [WP-2](2026-08-04-gis-wp2-drizzle-fundament.md) musste `schema.sql` (952 Zeilen mit RLS, Triggern, Functions) einfrieren und Drizzle nur für Neues zuständig machen — zwei Wahrheiten über dasselbe Schema, weil `drizzle-kit pull` auf diesem Bestand nichts Committbares liefert. Im Greenfield gibt es eine Schemadefinition in TypeScript und eine Initial-Migration. Das war der unsauberste Teil des gesamten Plans.

**Der Index-Drift verschwindet an der Wurzel.** Die zwei invaliden Indizes und die fünf nur-auf-Prod-Indizes sind der Anlass des ganzen Umbaus. Neu aufgebaut existieren sie nur noch in Migrationen.

**Das Serving-Modell kann direkt richtig entstehen.** Zwei Verstärker des heutigen Problems lassen sich im Greenfield vermeiden statt nachrüsten:

- **Koordinaten gehören auf `auctions`, nicht versioniert auf `auction_details`.** Heute liegen sie auf `auction_details` (verifiziert: `auctions` hat keine `lat`/`lng`-Spalten) und sind damit an eine Extraktionsversion gebunden. Eine neue Version ohne mitgeführte Koordinaten setzt die Abdeckung still zurück — das ist die wahrscheinlichste Ursache dafür, dass 30.909 Cache-Einträge nur 37 Koordinaten in der DB ergeben ([WP-3](2026-08-04-gis-wp3-geocoding-abdeckung.md)). Eine Position ist Identität, keine Extraktion.
- **`LATEST_DETAILS_JOIN_SQL` als `LEFT JOIN LATERAL … LIMIT 1`** ([auctions.get.ts:74-78](server/api/auctions.get.ts#L74-L78)) ist ein Nested Loop pro Auktionszeile in jeder Suche. Mit einem `is_latest`-Flag und partiellem Index wird das ein normaler Index-Join. Im Bestand war das ein eigenes Arbeitspaket; hier ist es eine Spalte.

**EPSG:3035 direkt beim Import.** osm2pgsql kann die Geometrien direkt in 3035 schreiben, statt 4326 zu speichern und in [WP-4](2026-08-04-gis-wp4-geo-features.md) zu transformieren. Damit entfällt ein Konvertierungsschritt und der `::geography`-Cast, der heute den 1.988 MB großen GIST-Index nutzlos macht, existiert nirgends mehr.

## Was es nicht vereinfacht

Der **OSM-Reimport** (20 GB, DE mehrere Stunden) fällt an — aber der stand wegen der neuen Tags in [WP-6](2026-08-04-gis-wp6-osm-datenausbau.md) ohnehin bevor. Kein zusätzlicher Aufwand, nur andere Reihenfolge.

Die **Auktionsdaten** müssen neu gecrawlt werden. 3.720 Auktionen sind überschaubar.

## Datenverlust: was wirklich weg ist

Der Nutzer hat entschieden; das hier ist die Grundlage dafür, es informiert zu tun.

**Nicht wiederbeschaffbar sind Zeitreihen.** `auction_observations` (19.582 Zeilen, 290 MB) und `artifact_captures` (65.104 Zeilen) halten Beobachtungen über Zeit — ein Crawl heute liefert den heutigen Zustand, nicht den vom 27. Juli. Genau dieser Verlust war schon einmal ein behandelter Vorfall (PR #220: Capture-Historie vor dem 27.7. war weg). Ebenso `auction_snapshot`, das beendete Auktionen bewusst behält (Permalink-Retention).

**Maßnahme:** `pg_dump` der vollständigen Datenbank vor dem Drop, off-instance abgelegt. Kostet Minuten und macht die Frage „sind die Daten wirklich unkritisch?" irrelevant. Ohne diesen Dump nicht anfangen.

**Der Geocode-Cache liegt im Dateisystem, nicht in der DB:** `/app/.cache_zvg/geocode` mit 30.909 Einträgen, davon ~18.400 erfolgreiche Auflösungen. Bei 1,1 s Mindestabstand ([geocode.ts:31](server/utils/geocode.ts#L31)) entspricht das etwa 5,6 Stunden Nominatim-Arbeit — und die Server-IP ist dort gebannt, also wäre es nicht einfach nachzuholen. Er überlebt einen DB-Reset **nur, wenn ihn niemand mit aufräumt.** Vor dem Neuaufbau prüfen, ob das Verzeichnis auf einem Volume liegt, und es separat sichern.

## Schritte

1. **`pg_dump` der bestehenden Datenbank.** Nicht optional. Ablage außerhalb der Instanz.
2. **Geocode-Cache sichern** (`/app/.cache_zvg/geocode`) und prüfen, ob er auf einem Volume liegt.
3. **Drizzle-Schema in TypeScript** unter `server/db/schema/` — vollständig, nicht nur die neuen Tabellen. Als Vorlage dient `schema.sql`; es wird gelesen und übersetzt, nicht per `pull` importiert. Dabei bewusst mitnehmen:
   - Koordinaten (`lat`/`lng`) auf `auctions`
   - `is_latest boolean` auf `auction_details` mit partiellem Index
   - `geo_features`, `auction_geo_metrics`, `climate_cells` gleich mit anlegen (Modelle in WP-4/5/7)
   - RLS: `schema.sql` aktiviert Row Level Security auf allen Tabellen. Drizzle generiert das nicht — als `-- custom`-SQL-Block in der Migration mitführen. **Das ist der leichteste Punkt zu vergessen und der mit den größten Folgen.**
   - Trigger, Functions und Check-Constraints aus `schema.sql` durchgehen und einzeln entscheiden. Hier entsteht der eigentliche Aufwand dieses WP; ein stillschweigend verlorener Constraint fällt erst Monate später auf.
4. **Initial-Migration generieren** und gegen eine **frische lokale Datenbank** anwenden. Nicht gegen Prod.
5. **`schema.sql` und der Bootstrap-Pfad entfallen.** [db-bootstrap.ts](server/plugins/db-bootstrap.ts) ruft `runMigrations()` in [db.ts](server/utils/db.ts) auf; das Verhalten (jeder Request wartet auf dieselbe Promise, Fehler als 503) ist gut gelöst und bleibt — nur die Quelle wird der Drizzle-Migrator statt `readFile('schema.sql')`.
6. **Prod: Drop und Neuaufbau.** Erst nach erfolgreichem lokalem Durchlauf. Danach Crawler und OSM-Import neu anstoßen.

## Verifikation

1. Der `pg_dump` ist vorhanden, lesbar und wiederherstellbar — testweise in eine leere Datenbank laden. Ein ungeprüfter Dump ist kein Backup.
2. Frische lokale DB + Initial-Migration → Anwendung startet, `pnpm test` läuft (`nuxt prepare` vorher).
3. `pnpm db:generate` auf dem unveränderten Schema erzeugt **keine** weitere Migration.
4. **RLS ist auf allen Tabellen aktiv** — gegen die Liste aus `schema.sql` abgleichen, nicht stichprobenartig:
```sql
SELECT tablename FROM pg_tables t WHERE schemaname='public'
  AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relname=t.tablename AND c.relrowsecurity);
```
5. Keine invaliden Indizes: `SELECT … FROM pg_index WHERE NOT indisvalid` = 0 Zeilen.
6. Ein Crawl-Lauf schreibt erfolgreich in das neue Schema — Constraints und Trigger greifen wie zuvor.
7. Geocode-Cache ist noch da und wird genutzt (Trefferquote > 0 bei einem Testlauf).

## Fallstricke

- **Ohne geprüften Dump anfangen.** Der Nutzer hat die Daten freigegeben, aber ein Dump kostet Minuten gegen einen irreversiblen Verlust.
- **Geocode-Cache mit aufräumen** → 5,6 Stunden Arbeit weg, und wegen des Nominatim-Bans nicht schnell nachholbar.
- **RLS vergessen.** `schema.sql` setzt es überall; Drizzle nicht von allein.
- **Trigger/Functions/Constraints stillschweigend verlieren.** Sie sind der Grund, warum `drizzle-kit pull` hier nicht taugt — also müssen sie manuell durchgegangen werden. Eine Checkliste gegen `schema.sql` führen, nicht aus dem Gedächtnis arbeiten.
- **`drizzle-kit push` gegen Prod** — nie. Nur `generate` + `migrate`.
- **Migrationsdateien fehlen im Docker-Image.** Nitro bundelt keine per `fs.readFile()` gelesenen Dateien; daran ist `schema.sql` schon einmal gescheitert. Die `.sql`-Migrationen haben dasselbe Problem — im gebauten Image prüfen, nicht lokal.
- **Reihenfolge:** Dieses WP ersetzt WP-2 und macht WP-1 fast vollständig obsolet. Läuft es nicht, gilt der ursprüngliche Baseline-Plan weiter — beide Wege nebeneinander zu verfolgen erzeugt genau den Drift, der das Problem war.
