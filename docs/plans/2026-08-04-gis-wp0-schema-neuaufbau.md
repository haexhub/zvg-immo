# WP-0 — Schema-Neuaufbau auf Drizzle (Greenfield)

Datum: 2026-08-04
Teil von [GIS-Architektur](2026-08-04-gis-scaling-architecture.md). Abhängig von: nichts. **Ersetzt den Baseline-Ansatz in WP-2 und verkleinert WP-1.**
Aufwand: 2–3 Tage. Repo: `zvg-immo`.

> **Status: ✅ ERLEDIGT — PR #313 (`gis-wp0-schema-neuaufbau`, gemergt als `a39fb52`), Prod-Reset durchgeführt.** `pg_dump` vorab erstellt und in einem Docker-Postgres verifiziert wiederherstellbar. RLS nachträglich verifiziert: 0 Anwendungstabellen ohne RLS. `pnpm db:generate` auf dem unveränderten Schema erzeugt keine weitere Migration.
>
> **Zwei Lücken, die die Verifikation dieses WP nicht abgedeckt hat und die als eigene Hotfixes nachgezogen wurden** — beide nur durch echtes Postgres-Testen gefunden, nicht durch Mocks:
> - **PR #314:** Vier Stellen im Code lasen Koordinaten noch über den alten `auction_details`-Alias (`d.lat`/`d.lng`) statt `a.lat`/`a.lng` — Schritt 6 dieses WP sagt "ein Crawl-Lauf schreibt erfolgreich", prüft aber nicht, ob **jeder Leser** der neuen Spaltenlage folgt. 500er auf `/api/auctions-geo` und geofilterten Suchen.
> - **PR #315:** `auction-details.ts` versuchte weiterhin, `lat`/`lng` in `auction_details` zu INSERTen — die Spalte existiert dort seit diesem WP nicht mehr, jeder Insert scheiterte, die Tabelle blieb bei 0 Zeilen. Zusätzlich fehlte das Schreiben von `lat`/`lng` nach `auctions` in `current-auctions.ts` komplett, und `auction_details.is_latest` (der partielle Unique-Index aus Schritt 3) wurde beim Schreiben einer neuen Version nie demotet. **Lektion für den nächsten Schema-Umbau dieser Art: "ein Crawl-Lauf schreibt erfolgreich" (Verifikationspunkt 6) muss die tatsächliche Ziel-Tabelle nach dem Lauf prüfen (`SELECT count(*)`), nicht nur den Exit-Code des Laufs — ein Insert kann fehlschlagen, ohne dass der aufrufende Task-Code das je bemerkt.**
>
> **Zusätzlicher, unabhängiger Nebeneffekt des Hard-Resets (kein Bug in diesem WP, aber eine Lücke in Schritt 6/Verifikation):** `app_settings` wurde beim `DROP SCHEMA` mitgeleert. Der Default `hide_rules_only_auctions = true` blendete danach jede Auktion ohne LLM-Analyse aus der Suche aus — bei 0 LLM-analysierten Auktionen direkt nach dem Reset praktisch alle. Für den nächsten Reset dieser Art: Liste der `app_settings`-Keys mit Nicht-Default-Werten vorher sichern und danach explizit re-applizieren.

## Entscheidung

Das **Anwendungsschema** wird verworfen und aus Drizzle neu aufgebaut. Der Nutzer hat das ausdrücklich freigegeben mit der Begründung, dass die Daten wiederbeschaffbar sind.

> **⚠️ Der Reset betrifft ausschließlich `public`.** Diese Datenbank ist eine Supabase-Instanz: `auth`, `storage`, `realtime`, `extensions` und `supabase_*` gehören der Plattform, nicht der Anwendung. Sie zu droppen zerstört die Installation — und `auth.users` enthält **Anmeldedaten, die durch keinen Crawl wiederherstellbar sind**. Die Freigabe des Nutzers bezog sich auf Auktionsdaten, nicht auf Konten.
>
> Konkret heißt das: kein `DROP DATABASE`, kein pauschales Drop über alle Schemas. Nur die Objekte in `public`, die zum Anwendungsschema gehören. Die PostGIS-Extension liegt je nach Setup in `public` oder `extensions` — vor dem Drop prüfen (`\dx`), sonst nimmt der Reset `postgis` mit und die Geometriespalten lassen sich nicht neu anlegen.

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

**Kommt die Historie zurück? Das ist eine Entscheidung, keine Nebenwirkung.** Der Dump allein stellt nichts wieder her — Schritt 6 dropt und startet neue Crawls, und damit bleiben `auction_observations`, `artifact_captures` und `auction_snapshot` leer. Zwei Wege, und einer davon muss vor dem Drop gewählt sein:

- **(a) Historie wird aufgegeben** — der Dump ist reines Notfallnetz. Das entspricht der Freigabe des Nutzers und ist der einfachere Weg. Folge: Zeitreihen beginnen bei null, und Auswertungen über den Verlauf sind erst in Zukunft wieder möglich.
- **(b) Historie wird selektiv zurückgeholt** — Dump in eine Staging-Datenbank laden, dann die drei Tabellen nach dem Neuaufbau importieren. Das ist mehr Arbeit als es klingt: die Fremdschlüssel zeigen auf `auctions`/`auction_details`, deren IDs nach einem Neuaufbau andere sind. Ein Import ohne Neuzuordnung über die fachlichen Schlüssel (`platform` + `external_id`) erzeugt verwaiste oder falsch verknüpfte Zeilen. Vor dem Drop klären, ob die Identität stabil bleibt.

Ohne bewusste Wahl passiert (a) stillschweigend. Die Entscheidung gehört ins WP-Protokoll, damit später klar ist, dass die Lücke gewollt war und kein Fehler.

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
4. **RLS ist auf allen Tabellen aktiv** — gegen die Liste aus `schema.sql` abgleichen, nicht stichprobenartig. Der Join muss über das Schema qualifiziert sein, sonst matcht `relname` gleichnamige Tabellen in `auth`/`storage` und das Ergebnis ist falsch negativ:
```sql
SELECT c.relname FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;
```
Zusätzlich prüfen, dass Policies existieren und greifen: RLS ohne Policy sperrt für Nicht-Superuser alles, was als „funktioniert" durchgehen kann, solange nur mit der `postgres`-Rolle getestet wird. Einmal unter der Rolle testen, die die Anwendung tatsächlich verwendet.
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
