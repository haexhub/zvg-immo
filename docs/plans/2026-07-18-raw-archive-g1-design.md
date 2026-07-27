# Roh-Original-Archiv (G1) — Design

**Status (2026-07-23): Phase 1-3 umgesetzt.** Schicht 1 (#92), Schicht 2 PDF/DOCX
(#93), Schicht 2b Detail-HTML (#100 + Follow-up #101, siehe
`2026-07-19-wp5-followup-html-archive.md`) — alle gemergt. Reprocessing-Tool
(hier als spätere Phase genannt) ist inzwischen als WP-6 im Supabase-Migrations-
Strang umgesetzt (PR #129, siehe `2026-07-22-supabase-full-migration-de.md`).

## Context

Aus dem Business-Case-Gespräch (Punkt 7: „Register periodisch abfragen, **einmal im
Original speichern**, anschließend in einheitliches Schema bringen") ist als einziger
*irreversibler* Architektur-Fork das **Roh-Archiv** herausgefallen. Heute wird nur der
normalisierte `CrawlResult` in den Disk-Cache (`.cache_zvg/list/*.json`, überschrieben)
und die abgeleitete Zeitreihe `auction_observations` (~15 Felder, dongarra Phase 3)
gespeichert. **Das Roh-Material — der vollständige geparste Stand pro Auktion, die
Detail-HTML-Seiten und die Gutachten-PDFs/DOCX, die der LLM tatsächlich liest — wird nach
dem Parsen verworfen.**

Was verloren geht, ist für immer weg: nicht-archivierte Crawls lassen sich nicht nachholen
(Quellen ändern sich, Rate-Limits/robots.txt blockieren Re-Crawls — siehe die einschlägigen
Memory-Einträge zu licitor/PT/Nominatim-429). Dieses Dokument spezifiziert das Archiv;
**es enthält bewusst keinen Code — Umsetzung erst nach Freigabe, dann pro Phase im eigenen
Worktree** (`EnterWorktree`, Projektkonvention).

### Der Widerspruch Punkt 7 ↔ Punkt 8, aufgelöst

Punkt 7 will „das Original speichern", Punkt 8 sagt „eventuell brauchen wir nicht die
kompletten Original-Anzeigen, sondern nur die gecrawlten Daten". Das Design löst das über
**Schichten unterschiedlichen Werts**:

- **Schicht 1 — Auktions-Snapshot (geparst):** der vollständige geparste Datensatz *pro
  Auktion* pro Änderung, unveränderlich archiviert. Das ist „nur die gecrawlten Daten" (P8),
  aber vollständig und für immer (P7). Ein Hook.
- **Schicht 2 — Roh-Dokumente (PDF/DOCX):** die Bytes, die F1/F2 (KI-Gutachten-Analyse)
  tatsächlich als Input lesen. Re-Processing mit besserem Prompt/Schema **ohne Re-Crawl**.
- **Schicht 2b — Roh-Detail-HTML:** viele Portale liefern in einigen Ländern **relevante
  Infos nur auf der HTML-Detailseite**, nicht als PDF/DOCX (Nutzer-Feststellung). Der
  geparste Snapshot (Schicht 1) reicht dafür nicht: ein heute vom Parser übersehenes Feld
  ist nur aus dem Roh-HTML rückholbar. Daher wird das Detail-HTML roh archiviert.

Nicht Teil dieses Plans: **Schicht 3** (geteilter Fetch-Wrapper, der *jeden* HTTP-Response
mitschneidet, inkl. Listen-HTML). Maximale Provenienz, aber massenhaft niedrigwertiges
Listen-HTML — bewusst zurückgestellt (siehe „Explizit nicht Teil").

### Ist-Zustand (verifiziert im Code)

- **Kein gemeinsamer HTTP-Helper:** jeder der ~30 Crawler importiert `undici`/`fetch`
  selbst. Es gibt keinen zentralen Punkt auf HTTP-Ebene.
- **Zwei Flows, die auseinanderzuhalten sind:**
  - `refresh.ts` → `crawlSingle({enrichDetails:false})` → CrawlResult (Listen-Ebene) →
    `writeListCache`. **Trägt noch keine Detail-Daten.**
  - `enrich.ts` → `crawlAll` → pro Auktion `enrichOne()` (fetcht **Detail-HTML** +
    Dokumente) → extrahiert → schreibt `auction-snapshot`/`extraction-cache`. **Hier**
    entstehen `beschreibung`/`attachments`/`source*`-Felder — und hier wird das Roh-HTML
    fetchte-und-verworfen.
- **Choke-Point Schicht 1 (parsed):** die zusammengeführten geparsten Auktionen. Praktisch
  am einfachsten in `refresh.ts:55` (Listen-Ebene, alle Regionen) plus – für die
  Detail-Felder – am Ende von `enrich.ts` je Auktion. (Siehe „Server-seitige Änderungen".)
- **Choke-Point Schicht 2 (Dokumente):** `fetchPdfBuffer(proxyUrl)` in
  `server/utils/extract/pdf-text.ts:47` ist *der* geteilte PDF-Fetch (Konsumenten:
  `pdfToText`, `pdf-images.ts`, `api/pdf-thumb.get.ts`). DOCX getrennt in
  `server/utils/extract/docx-text.ts`.
- **Schicht 2b (Detail-HTML) hat KEINEN zentralen Punkt** — Detail-Fetch liegt in jedem
  Crawler (`enrichOne`/`detail.ts`). Braucht einen geteilten Wrapper, den Crawler übernehmen.
- **Identität ist im Typ garantiert:** `Auction.externalId` (Pflicht, „stable per-platform
  id; non-DE-Crawler füllen ihren nativen Identifier") + `caseNumber` + `authority`. Damit
  ist `(platform, externalId)` immer verfügbar; `(authority, caseNumber)` ist laut dongarra
  über Läufe hinweg sogar stabiler (Dedup-Gewinner kann die Plattform wechseln).
- **DB-Schicht steht bereits** (dongarra, im Merge): `server/utils/db.ts` (`getPool()`,
  `runMigrations()` führt `server/db/schema.sql` idempotent aus), `db-bootstrap.ts`. Ohne
  `NUXT_DATABASE_URL` ist alles No-Op — Graceful-Degrade wie `extractLlm.baseUrl`.
- **Cache-Muster:** `server/utils/json-cache.ts` `writeJsonCache()` (atomar via tmp+rename),
  Pfad-Sicherheit über `SCOPE_PARAM_RE`/`isSafePathSegment`.

## Architekturentscheidungen

- **Speicher = plain S3, NICHT Supabase Storage.** Supabase Storage ist im Kern eine
  RLS-/Signed-URL-/Client-Upload-Schicht über einem S3-Backend — nichts davon wird gebraucht
  (server-seitiger Write + Read, kein Client-Upload, Zugriffskontrolle in der App). Es wäre
  ein Extra-Container + Extra-Tabellen für null Mehrwert, und dongarra hat Supabase Storage
  bewusst aus dem Stack gelassen. Stattdessen: **ein S3-kompatibler Bucket** als Primary; die
  Metadaten liegen wie gehabt in Postgres (`raw_blobs`/`raw_captures`).
- **Backup = zweiter Bucket bei einem reinen S3-Provider** (Nutzer-Entscheidung, günstigste
  Option: Backblaze B2 / Wasabi / Hetzner). Replikation via `rclone copy` (append-only,
  **nie `sync`** — `sync` würde bei kaputtem Primary das Backup leeren). Blobs sind immutabel
  und hash-benannt → `copy` ist idempotent.
- **Schreibpfad: lokale Outbox → Uploader → Primary-S3 → Backup-S3.** Der Crawl schreibt den
  Blob zuerst in ein kleines lokales Outbox-Volume (schnell, netzunabhängig), ein Uploader
  lädt nach Primary und löscht lokal **erst nach bestätigtem Upload**. So hängt der
  Crawl-/Enrich-Schreibpfad nie an S3-Verfügbarkeit, und ein transienter S3-Fehler verliert
  nichts (die Bytes bleiben lokal, bis der Upload klappt). Die Outbox hält nur
  noch-nicht-hochgeladene Blobs — kein unbegrenztes lokales Wachstum.
- **Content-Hash-Dedup (sha256).** Identische Bytes werden genau einmal gespeichert
  (S3-Key = Hash, sharded `ab/cdef…`). PDFs dominieren das Volumen (5–50 MB/Gutachten) —
  Dedup ist Voraussetzung, nicht Optimierung.
- **Identität ≠ Content — zwei orthogonale Achsen:**
  - *Identität* (welche Auktion): `(platform, external_id)`, zusätzlich
    `case_number`+`authority` mitgeschrieben. Das sind die Terminologie-
    Migrationsnamen für die früheren `zvg_id`/`aktenzeichen`/`amtsgericht`
    Felder.
  - *Content-Hash* (haben sich die Daten geändert): pro Blob.
  Deshalb wird **pro Auktion** archiviert (nicht ein Region-Blob): nur *tatsächlich
  geänderte* Auktionen erzeugen einen neuen Blob. **Das löst den `fetchedAt`-Footgun von
  selbst** — das einzelne `Auction`-Objekt trägt keinen Pro-Lauf-Zeitstempel (der saß nur im
  CrawlResult-Envelope). Zur Sicherheit wird der Auktions-Content vor dem Hashen kanonisiert
  (stabile Schlüssel-Sortierung; unser `detailFetchedAt` ausgeschlossen).
- **Kompression differenziert:** geparstes JSON + HTML werden gzippt (Text komprimiert
  stark); PDF/DOCX **roh** (schon komprimiert). `content_type` unterscheidet.
- **Archivieren ist strikt Best-Effort.** Jeder Archiv-Aufruf ist gefangen und wirft nie —
  Resilienz-Regel von `recordObservations`/`matchAlerts`. Ohne DB/S3-Config = No-Op + Log.
- **Blobs = Bytes, Postgres = Index.** S3-Key ist der Content-Hash → der Bucket ist
  selbstbeschreibend; die Postgres-Tabellen sind ein rekonstruierbarer Abfrage-Index, kein
  Single Point of Failure für die Daten.

## Datenmodell (`server/db/schema.sql`, angehängt; via `runMigrations()` idempotent)

```sql
-- G1 Roh-Archiv. raw_blobs = deduplizierte Bytes (S3-Key = content_hash),
-- raw_captures = append-only Log "wann zeigte welche Auktions-Identität auf welchen Blob".
-- Muster wie auction_observations (append-only, kein RLS, server-intern).
CREATE TABLE IF NOT EXISTS raw_blobs (
  content_hash  text PRIMARY KEY,          -- sha256 der (kanonisierten) Bytes
  s3_key        text NOT NULL,             -- sharded Key im Primary-Bucket, z.B. 'ab/abcd….json.gz'
  content_type  text NOT NULL,             -- 'application/json+gzip' | 'text/html+gzip' | 'application/pdf' | 'application/vnd.docx'
  byte_size     bigint NOT NULL,           -- Größe wie abgelegt
  first_seen_at timestamptz NOT NULL,
  uploaded_at   timestamptz                -- gesetzt, sobald Primary-Upload bestätigt (null = noch in Outbox)
);

CREATE TABLE IF NOT EXISTS raw_captures (
  id            bigserial PRIMARY KEY,
  captured_at   timestamptz NOT NULL,
  kind          text NOT NULL,             -- 'auction' | 'document' | 'detail_html' | 'document_text'
  platform      text NOT NULL,
  country       text NOT NULL,
  external_id   text NOT NULL,             -- Auktions-Identität (immer vorhanden; ehem. zvg_id)
  case_number   text,                      -- stabilere Cross-Run-Identität (ehem. aktenzeichen)
  authority     text,                      -- ehem. amtsgericht
  content_hash  text NOT NULL REFERENCES raw_blobs(content_hash),
  source_url    text                       -- Upstream-URL (Provenienz)
);
CREATE INDEX IF NOT EXISTS idx_capt_identity_time ON raw_captures (platform, external_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_capt_az_time       ON raw_captures (authority, case_number, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_capt_hash          ON raw_captures (content_hash);
-- Kein RLS: server-intern, nie clientseitig exponiert (wie auction_observations).

CREATE TABLE IF NOT EXISTS raw_document_sets (
  id              bigserial PRIMARY KEY,
  captured_at     timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  platform        text NOT NULL,
  country         text NOT NULL,
  region          text,
  external_id     text NOT NULL,
  case_number     text,
  authority       text,
  set_hash        text NOT NULL,           -- stabile Manifest-Identität ohne ordinal
  version         integer NOT NULL,        -- laufende Version pro (platform, external_id)
  document_count  integer NOT NULL,
  UNIQUE (platform, external_id, set_hash),
  UNIQUE (platform, external_id, version)
);

CREATE TABLE IF NOT EXISTS raw_document_set_items (
  set_id        bigint NOT NULL REFERENCES raw_document_sets(id) ON DELETE CASCADE,
  ordinal       integer NOT NULL,          -- Anzeige-/Crawler-Reihenfolge dieser Version
  kind          text NOT NULL,
  label         text,
  filename      text,
  file_id       text,                      -- stabile Dokument-Identität, falls die Quelle sie liefert
  source_url    text NOT NULL,             -- fallback Identität und Provenienz
  content_hash  text NOT NULL REFERENCES raw_blobs(content_hash),
  content_type  text NOT NULL,
  PRIMARY KEY (set_id, ordinal)
);
```

**Change-only Capture.** Ein `raw_captures`-Insert erfolgt für Auktions-Snapshots nur,
wenn der `content_hash` sich gegenüber der jüngsten Capture derselben
`(kind, platform, external_id)` unterscheidet. Dokumente werden zusätzlich über
`source_url`/`content_hash` dedupliziert, damit mehrere Dokumente derselben Auktion
unabhängig adressierbar bleiben. Das aktuelle gültige Dokument-Bündel liegt in
`raw_document_sets`: ein unverändertes Dokument wird über seinen `content_hash` in einer
neuen Set-Version wiederverwendet; hinzugefügte, aktualisierte oder zurückgezogene
Dokumente erzeugen nur ein neues Manifest. Ein Rückzug wird dadurch sichtbar, dass ein
früheres `raw_document_set_items`-Mitglied in der neuesten Set-Version fehlt; `last_seen_at`
am Set hält fest, wann genau diese Version zuletzt bestätigt wurde.

## S3-Kosten-Hinweis (bewusst, kein Silent Cap)

Erster Lauf = ein PUT pro Auktion (tausende, einmalig). Steady State = nur PUTs für
tatsächlich geänderte Auktionen/neue Dokumente (dank Dedup wenige/Tag). PUT-Requests kosten
je nach Provider ein wenig — durch Change-only + Dedup bleibt das minimal. Wird bei der
Umsetzung grob gegen den gewählten Provider-Tarif gegengerechnet.

## Auslieferungs-Policy (Original-Links & Dokumente) — Produkt-/Rechtsentscheidung

Betrifft nicht das Archiv selbst, aber eng verwandt (was von den Originalen wird nutzerseitig
gezeigt). Empfehlung, finale Entscheidung liegt beim Betreiber:

- **Link auf die Original-URL zeigen — eher NICHT hinter Paywall.** Die Quellen sind
  öffentliche, kostenlose amtliche Register; die URL zu verstecken schützt keinen Moat und
  wirkt nutzerfeindlich. Der Moat ist die Aggregation (Normalisierung, 20+ Länder, Alerts,
  KI-Analyse, Historie). Wenn gegated wird, dann *Bequemlichkeit* (angereicherte Deep-Links),
  nicht das Wissen um die Quelle. `Auction.detailUrlUpstream`/`pdfUrlUpstream` sind bereits
  vorhanden.
- **Die archivierte Kopie NICHT öffentlich ausliefern.** Fremde Gutachten aus dem eigenen
  S3-Blob re-hosten berührt Urheber-/Datenbankrecht + DSGVO (Personenbezug in Gutachten).
  Für nutzerseitige Dokumente die **Live-Quelle proxien** (bestehendes
  `/api/zvg-proxy`-Muster), nicht die Archiv-Kopie. **Das Archiv bleibt intern**
  (Re-Processing, Provenienz) — Archiv ≠ Auslieferungs-CDN.
- **Rechtlicher Flag:** ein bezahltes „Dokumente/Original"-Feature gehört vor Launch
  juristisch geprüft (DB-Herstellerrecht, ToS der Quellen, DSGVO). Nicht Teil dieses Plans,
  aber hier dokumentiert, damit die Trennung Archiv/Auslieferung bewusst bleibt.

## Neue Infrastruktur (`docker-compose.yml`)

- **Kleines lokales Outbox-Volume** am `app`-Service (z.B. `/app/.raw_outbox`) — nur
  noch-nicht-hochgeladene Blobs, nicht das Archiv.
- **`app`-Service Env:** `NUXT_S3_ENDPOINT`, `NUXT_S3_BUCKET`, `NUXT_S3_ACCESS_KEY`,
  `NUXT_S3_SECRET_KEY`, `NUXT_S3_REGION`, `NUXT_RAW_OUTBOX_DIR`. Archiv aktiv, sobald S3-Config
  **und** `NUXT_DATABASE_URL` gesetzt sind.
- **Neuer Sidecar `raw-archive-backup`** (`rclone/rclone`): Cron-Loop
  `rclone copy primaryS3: backupS3:` (zwei S3-Remotes, append-only, nie `--delete`).
  Credentials via `.env`/Compose-Secrets, nicht im Image.
- **`.env.example`:** S3-Primary- und -Backup-Credentials + Endpoints dokumentiert, gleiche
  Konvention wie bestehende Einträge.

## Server-seitige Änderungen (Datei für Datei)

- **`server/db/schema.sql`** — die beiden `CREATE TABLE IF NOT EXISTS`-Blöcke anhängen.
- **`server/utils/raw-archive.ts`** (neu) — zentraler Helfer:
  - `archiveBlob(bytes, contentType, { canonicalBytesForHash? })`: sha256, Existenz-Check
    `raw_blobs`; bei Miss: gzip-wo-Text, Write in die **Outbox** (atomar tmp+rename), Insert
    `raw_blobs` (`uploaded_at=null`). Idempotent, gibt `content_hash` oder null (No-Op) zurück.
  - `recordCapture({...Identität, content_hash, source_url})`: Change-only-Insert.
  - `archiveAuction(auction, capturedAt)`: kanonischer Auction-Content → `archiveBlob` →
    `recordCapture(kind='auction')`. Keyed auf `(platform, external_id)`.
- **`server/utils/s3-uploader.ts`** (neu) — drainiert die Outbox: für jeden Blob ohne
  `uploaded_at` PUT nach Primary, dann `uploaded_at` setzen + lokale Datei löschen. Als
  Scheduled Task / am Ende von `refresh` getriggert. Best-Effort, Retry beim nächsten Lauf.
- **`server/tasks/refresh.ts`** — nach `writeListCache(...)` (Z.55) gefangen:
  `for (const a of result.auctions) await archiveAuction(a, capturedAt)` (Listen-Ebene) +
  Uploader-Drain am Ende. `capturedAt` existiert (Z.35).
- **`server/tasks/enrich.ts`** — nach erfolgreicher Anreicherung einer Auktion: erneut
  `archiveAuction(enrichedAuction, ...)` (jetzt inkl. `beschreibung`/`attachments`/`source*`)
  → neuer Content-Hash, wenn Detail-Daten dazukamen. So landet auch der angereicherte Stand
  im Archiv, nicht nur der Listen-Stand.
- **`server/utils/extract/pdf-text.ts`** — in `fetchPdfBuffer()` nach validiertem Fetch:
  `archiveBlob(buf,'application/pdf')` + `recordCapture(kind='document', source_url=url)`.
  Läuft für alle drei PDF-Konsumenten mit.
- **`server/utils/extract/docx-text.ts`** — analog für DOCX-Bytes.
- **`server/utils/fetch-archive.ts`** (neu, Schicht 2b) — `fetchTextAndArchive(url, opts)`:
  fetcht (undici, wie bisher), archiviert die Roh-HTML-Bytes best-effort
  (`kind='detail_html'`, keyed auf `(platform, zvgId)` aus `opts`), gibt den Text zurück.
  Drop-in-Ersatz für das rohe `fetch→text` in den Detail-Fetchern.
- **Crawler-Migration (Schicht 2b), inkrementell:** die Detail-Fetcher der Crawler auf
  `fetchTextAndArchive()` umstellen — **HTML-only-Länder zuerst**. **Erste Aufgabe der Phase
  = kurzer Audit**, welche Crawler relevante Infos *nur* im Detail-HTML haben (kein
  vollständiges PDF/DOCX). Bis ein Crawler migriert ist, hat das Land kein HTML-Archiv — das
  wird explizit protokolliert (kein Silent Gap).
- **`nuxt.config.ts`** — `runtimeConfig` für S3 + Outbox-Dir (Empty-String-Defaults,
  Kommentarblock im Stil von `extractLlm.baseUrl`).
- **`package.json`** — S3-Client (`@aws-sdk/client-s3` oder `minio`); `zlib` ist in Node.

## Re-Processing-Pfad (historisch; inzwischen WP-6)

Der Nutzen von Schicht 2/2b — F1/F2 bzw. den Parser mit besserer Logik neu laufen lassen
ohne Re-Crawl — wurde später als WP-6 im Supabase-Migrations-Strang umgesetzt
(`2026-07-22-supabase-full-migration-de.md`). In diesem ursprünglichen G1-Plan war nur
das *Capturing* enthalten. Das Modell war dafür ausgelegt:
`(platform, external_id) → raw_captures/raw_document_sets → content_hash → raw_blobs → S3`.

## Phasierung (empfohlen: 3 Worktrees/PRs)

1. **Schicht 1 + Infra + S3 + Backup** — Schema, `raw-archive.ts`, `s3-uploader.ts`, Hooks in
   `refresh.ts` **und** `enrich.ts`, Outbox-Volume, S3-Config, `rclone`-Backup-Sidecar, `.env`.
   Ab Merge wird der komplette geparste Stand (Listen + angereichert) pro Auktion archiviert,
   Primary+Backup. Sofort verlust-stoppend.
2. **Schicht 2 (Dokumente)** — Hooks in `pdf-text.ts` + `docx-text.ts`. Baut nur auf
   `raw-archive.ts` auf.
3. **Schicht 2b (Detail-HTML)** — `fetch-archive.ts` + Crawler-Audit + inkrementelle
   Migration der HTML-only-Crawler.

(Historisch: Reprocessing-Tool + Schicht 3 waren hier als spätere, separate Pläne
notiert; WP-6 hat den Reprocessing-Pfad inzwischen geliefert.)

## Verifikation

- **Phase 1:** `refresh`-Lauf mit S3+DB-Config → pro Auktion ein `auction`-Blob in der Outbox,
  Uploader schiebt ihn nach Primary (`uploaded_at` gesetzt, lokal gelöscht). Zweiter Lauf
  **ohne Quelländerung** → **kein** neuer Blob, **keine** neue Capture (Dedup + Change-only;
  beweist, dass der `fetchedAt`-Footgun via Per-Auktions-Hashing umgangen ist). `enrich`-Lauf
  → für angereicherte Objekte ein zweiter Blob mit `beschreibung`/`attachments`. Ohne
  S3/DB-Config → sauberer No-Op, Crawl läuft normal.
- **Backup:** `rclone copy` → Blobs im Backup-Bucket; erneuter `copy` lädt nichts Neues
  (idempotent). `sync` nirgends verwendet (grep-Check).
- **Phase 2:** Objekt mit Gutachten enrichen → PDF-Blob (roh, nicht gzippt) + `document`-
  Capture mit `source_url`. Zweites Objekt mit demselben PDF → **kein** zweiter Blob
  (Hash-Dedup), zweite Capture-Zeile.
- **Phase 2b:** Für ein Objekt aus einem migrierten HTML-only-Land → `detail_html`-Blob,
  gzippt, keyed auf `(platform, external_id)`; entpackt = das rohe Detail-HTML. Nicht-migriertes
  Land → kein HTML-Blob, Log-Hinweis (kein Fehler).
- **Resilienz:** DB/S3 absichtlich während `refresh` stoppen → Crawl + `writeListCache` laufen
  unbeeinflusst; Blobs bleiben in der Outbox, Upload holt beim nächsten Lauf nach (kein
  Verlust, kein Throw).
- Bestehendes Typecheck/Test grün halten (`pnpm exec nuxi prepare && pnpm exec tsc -p
  .nuxt/tsconfig.server.json --noEmit`, `pnpm test`); Vitest für `raw-archive.ts`
  (Kanonisierung, Sharding, Dedup, Change-only).

## Explizit nicht Teil dieses Plans

- **Schicht 3** (jeder HTTP-Response inkl. Listen-HTML) — 30 Crawler + viel wertloses
  Listen-HTML; erst bei konkretem Bedarf (z.B. rechtliche Voll-Provenienz) neu bewerten.
- **Supabase Storage** — bewusst nicht; plain S3 + Postgres-Index deckt den Bedarf ohne
  Extra-Container/Tabellen.
- **Öffentliche Auslieferung der Archiv-Kopien** — Archiv ist intern; nutzerseitige
  Dokumente proxien die Live-Quelle (siehe Auslieferungs-Policy).
- **Reprocessing-Tooling** (Archiv → Extraktion/Analyse neu fahren) — eigene Folge-Phase.
- **Backfill** — Archiv beginnt ab Merge; vergangene Crawls sind nicht rekonstruierbar
  (wie `auction_observations`).
- **Retention/Lifecycle** (alte Blobs verfallen lassen) — append-only in v1; Aufräum-Politik
  später, wenn Volumen/Kosten real sind.
