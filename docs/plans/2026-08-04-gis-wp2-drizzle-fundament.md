# WP-2 — Drizzle als Schema- und Migrationsschicht

Datum: 2026-08-04
Teil von [GIS-Architektur](2026-08-04-gis-scaling-architecture.md). Abhängig von: nichts (parallel zu WP-1 möglich).
Aufwand: 2–3 Tage. Repo: `zvg-immo`.

> **⚠️ Überholt durch [WP-0](2026-08-04-gis-wp0-schema-neuaufbau.md).** Der Nutzer hat den vollständigen Schema-Neuaufbau freigegeben, womit der Baseline-Ansatz dieses Dokuments (schema.sql einfrieren, Drizzle nur für Neues) entfällt — er war der Kompromiss für den Fall, dass der Bestand erhalten bleiben muss. **WP-0 statt dieses WP umsetzen.**
>
> Zwei Abschnitte hier bleiben unverändert gültig und werden von WP-0 verwendet: **PostGIS-Typen** (`customType`, weil Drizzles `geometry()` point-only ist) und **der Docker-Fallstrick** (Nitro bundelt keine per `fs.readFile()` gelesenen Dateien). Der Rest ist Fallback, falls der Neuaufbau nicht stattfindet.

## Warum

Heute gibt es kein Migrationssystem. [db-bootstrap.ts](server/plugins/db-bootstrap.ts) wendet [schema.sql](server/db/schema.sql) (952 Zeilen, alles `IF NOT EXISTS`) bei **jedem Start** idempotent an; DB-Zugriff ist rohes SQL über einen `pg`-Pool.

Das hat einen konkreten, gemessenen Preis: Auf Prod existieren fünf Indizes auf `osm_local_elements`, die in `schema.sql` **nicht vorkommen** — manuell angelegt, zwei davon durch fehlgeschlagenes `CREATE INDEX CONCURRENTLY` im Zustand `indisvalid = false`. Das blieb wochenlang unentdeckt und ist die Ursache des Serverausfalls (siehe [WP-1](2026-08-04-gis-wp1-index-notfall.md)). Ein Bootstrap, der nur „fehlt es?" prüft, kann so einen Drift strukturell nicht erkennen — versionierte Migrationen können es.

Die neuen Tabellen dieses Plans (`geo_features`, `auction_geo_metrics`, `climate_cells`) sind der ideale erste Anwendungsfall: flache Zahlentabellen, genau wo ein ORM trägt.

## Ziel

1. `drizzle-kit` erzeugt und wendet versionierte Migrationen an; ein Drift wird sichtbar.
2. Neue Tabellen werden in TypeScript definiert, nicht in `schema.sql`.
3. PostGIS-Spalten (`geometry(Geometry, 3035)`) sind typisiert nutzbar.
4. Bestehender Code läuft unverändert weiter.

## Zuschnitt: Baseline, kein Big-Bang

`drizzle-kit pull` auf 952 Zeilen Schema mit RLS-Policies, Triggern, Functions und Check-Constraints liefert nichts, was man committen möchte. Der Weg ist eine **Baseline**:

- `schema.sql` bleibt als Ausgangszustand und wird weiter beim Start angewandt. Es wird **eingefroren**: keine neuen Tabellen, keine neuen Spalten mehr dort.
- Drizzle übernimmt ab jetzt für alles Neue und alle Änderungen.
- Bestehende Roh-SQL-Aufrufe bleiben. Sie werden nur angefasst, wenn ohnehin ein Grund besteht.

Diese Regel gehört in `CLAUDE.md`, sonst zerfällt sie beim nächsten Feature.

## Schritte

### 1. Installation und Konfiguration

`drizzle-orm` und `drizzle-kit` (dev) via **pnpm** (das Projekt nutzt kein npm).

`drizzle.config.ts` im Projektwurzelverzeichnis: Dialekt `postgresql`, Schema-Pfad `server/db/schema/*.ts`, Migrations-Ausgabe `server/db/migrations`, Connection aus `NUXT_DATABASE_URL` (dieselbe Variable, die [db.ts](server/utils/db.ts) liest).

Wichtig: `tablesFilter` bzw. `schemaFilter` so setzen, dass Drizzle die Supabase-eigenen Schemas (`auth`, `storage`, `realtime`) **nicht** anfasst. Ohne das erzeugt der erste `generate`-Lauf Migrationen, die Supabase-Interna verändern wollen.

### 2. Baseline-Marker setzen

Drizzle muss wissen, dass der bestehende Zustand schon existiert, sonst generiert es `CREATE TABLE` für alles. Zwei gangbare Wege:

- **Empfohlen:** Nur die *neuen* Tabellen in Drizzle-Schemadateien definieren. Die alten kommen nie in ein Drizzle-Schema, also erzeugt `generate` auch nie etwas für sie. Einfach, und passt zur Baseline-Regel.
- Alternativ `drizzle-kit pull` in eine `_baseline.ts` und die erste Migration als bereits angewandt markieren. Mehr Aufwand, mehr Nachbearbeitung, und bei RLS/Triggern unvollständig.

Der erste Weg genügt für diesen Plan.

### 3. PostGIS-Typen

Drizzle unterstützt GIST-Indizes deklarativ (`index().using('gist', table.geom)`) und `geometry({ type: 'point', srid: … })` — aber **nur für Point**. Für `geometry(Geometry, 3035)` mit gemischten Typen (Point/LineString/Polygon) und für `geography` ([noch offener PR](https://github.com/drizzle-team/drizzle-orm/pull/3021)) braucht es `customType`:

```ts
import { customType } from 'drizzle-orm/pg-core'

/** geometry(Geometry, <srid>) — mixed geometry types, which Drizzle's built-in
 *  geometry() does not cover (it is point-only). Values are read and written as
 *  EWKB hex strings; every actual geometry operation happens in SQL, so this
 *  type only needs to name the column correctly for DDL. */
export const geometryColumn = (srid: number) =>
  customType<{ data: string; driverData: string }>({
    dataType: () => `geometry(Geometry, ${srid})`,
  })
```

Bewusste Grenze: `ST_Subdivide`, `ST_DWithin`, `ST_Distance` und der KNN-Operator `<->` bleiben `sql`-Template-Literale. Drizzle soll sie **nicht** abstrahieren — der Nutzen wäre gering und der Verlust an Kontrolle über den Query-Plan bei genau den Queries hoch, die in diesem Projekt schon einmal den Server gekostet haben.

### 4. Migrations-Pipeline

Skripte in `package.json`: `db:generate` (`drizzle-kit generate`), `db:migrate`, `db:check`.

Migrationen im laufenden Betrieb anwenden: `migrate()` aus `drizzle-orm/postgres-js/migrator` bzw. `node-postgres/migrator` in `runMigrations()` in [db.ts](server/utils/db.ts) ergänzen — **nach** dem bestehenden `schema.sql`-Lauf. Die Reihenfolge ist wichtig: die Baseline muss stehen, bevor Drizzle-Migrationen darauf aufsetzen.

Das bestehende Verhalten von [db-bootstrap.ts](server/plugins/db-bootstrap.ts) beibehalten: jeder Request wartet auf dieselbe Promise, Fehler schlagen als 503 durch. Das ist gut gelöst und braucht keine Änderung.

### 5. Der Docker-Fallstrick

**Nitro bundelt keine Dateien, die per `fs.readFile()` gelesen werden.** Genau daran ist `schema.sql` schon einmal gescheitert — es fehlte im Docker-Image. Die Drizzle-Migrationen sind `.sql`-Dateien in `server/db/migrations` und haben dasselbe Problem.

Vor dem Deploy prüfen: Migrationsdateien müssen im gebauten Image vorhanden sein. Entweder über Nitros `serverAssets`/`publicAssets` einbinden oder im [Dockerfile](Dockerfile) explizit kopieren — analog zu dem, was für `schema.sql` gemacht wurde. Ein grüner lokaler Lauf beweist hier nichts.

### 6. Verifikation

1. `pnpm db:generate` auf unverändertem Schema erzeugt **keine** Migration (sonst stimmt der Baseline-Zuschnitt nicht).
2. Eine Testtabelle hinzufügen → `generate` erzeugt genau eine Migration → `migrate` wendet sie an → erneutes `generate` ist leer. Danach zurückrollen.
3. `nuxt prepare` und `pnpm test` laufen (das Projekt braucht `nuxt prepare` vor Tests).
4. Container-Build enthält `server/db/migrations/*.sql` — im Image prüfen, nicht nur lokal.
5. Supabase-Schemas sind unangetastet: die generierte Migration darf nichts in `auth`/`storage` enthalten.

## Fallstricke

- **`drizzle-kit push` nie gegen Prod.** `push` diffed direkt gegen die Datenbank und kann Spalten löschen. Nur `generate` + `migrate`.
- **Supabase-Schemas nicht ausgefiltert** → erste Migration will Supabase-Interna ändern.
- **Migrationsdateien fehlen im Image** → dieselbe Klasse Fehler wie bei `schema.sql`.
- **RLS:** `schema.sql` setzt `ENABLE ROW LEVEL SECURITY` auf allen Tabellen. Für neue Tabellen muss das in der Drizzle-Migration mitkommen; Drizzle generiert es nicht von allein. Ein `-- custom`-SQL-Block in der Migration ist der Weg.
- **Nicht das ganze Schema migrieren wollen.** Der Reiz ist groß, weil `schema.sql` unübersichtlich ist. Es ist aber unabhängige Arbeit ohne Bezug zum GIS-Ziel und riskiert RLS/Trigger-Regressionen.
