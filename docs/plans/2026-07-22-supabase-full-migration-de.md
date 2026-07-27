# Vollständige Supabase-Migration — Deutschland zuerst sauber

**Datum:** 2026-07-22
**Ziel:** Ein Land (DE) komplett sauber: alle Rohdaten in Supabase, LLM-Extraktion
vollständig (inkl. Zustand/Ausstattung, Bild-PDFs, Preise/Termine), alles im
Frontend sauber angezeigt. Erst danach weitere Länder.

**Status (2026-07-23):** WP-1 bis WP-6 (#123-#129) alle gemergt. Der ursprünglich
hier grob skizzierte Rest (WP-7 Vision härten, WP-8 Frontend-Feinschliff, WP-9
voller DE-Durchlauf) wurde durch `docs/plans/2026-07-22-de-crawler-photos-cards-plan.md`
(WP-0/A-E) ersetzt/detailliert ausgearbeitet — dieser Nachfolgeplan deckt
denselben Scope ab (Foto-Pipeline, Vision/native-PDF, Frontend-Cards,
DE-Reprocessing) und ist bereits weiter fortgeschritten (WP-A-D erledigt bzw.
zur Review, nur WP-E/„voller Durchlauf" steht noch aus). Für den aktuellen
Stand dort weiterlesen, nicht hier bei WP-7/8/9 wieder einsteigen.

---

## 1. Ausgangslage (verifiziert am 2026-07-22)

Was **schon in der Ziel-Persistenz** liegt:

- **Relationale App-Daten** (Postgres): `saved_searches`, `watchlist_items`,
  `auction_observations`, `alert_subscriptions`, `lawyers`, `api_keys`,
  `content_translations` (Live-Übersetzung DE/EN, PR #98) usw.
- **Roh-Archiv** (plain S3 bzw. S3-kompatibler Primary-Bucket, nicht Supabase
  Storage, seit PR #120/#122): content-addressed Bytes (`raw_blobs`) +
  append-only Log (`raw_captures`) für JSON-Snapshot, PDF/DOCX-Gutachten und
  Detail-HTML aller Crawler. Schreibpfad: lokale Outbox → Uploader lädt nach S3,
  bestätigt-dann-lokal-löschen. **Das ist ein unveränderliches Archiv fürs
  Reprocessing, KEIN Serving-Pfad.**

Was **noch NICHT in Supabase** liegt (die eigentliche Migrationslücke):

1. **Strukturierte Auktionsdaten — Serving läuft über lokale Dateien.**
   `/api/auctions`, `/api/auctions-geo`, `/api/auction/[platform]/[id]`,
   `/api/data/v1/*` lesen alle aus `.cache_zvg/auctions.json` (Snapshot) +
   `.cache_zvg/extraction.json` + `.cache_zvg/verkehrswert.json` auf dem
   lokalen Volume. Die Postgres-Tabelle `auctions` (`current-auctions.ts`,
   von `enrich.ts` befüllt) ist ein **write-only Spiegel — niemand liest sie**.
2. **Bilder** liegen auf dem lokalen Volume (`.cache_zvg/images/<platform>/<id>/`),
   ausgeliefert via `/api/auction-image`. Nicht in Supabase.
3. **Extraktions-Cache / Verkehrswert-Cache / Snapshot** sind lokale JSON-Dateien
   und faktisch die operative Wahrheit. Wird das Volume gelöscht, gehen
   Extraktionsergebnisse verloren → kompletter (teurer) LLM-Neulauf.

**Kernproblem:** Die lokalen JSON-Caches sind heute die Source of Truth,
Postgres `auctions` ist ein toter Spiegel. Vollständige Migration heißt: das
umdrehen — **Postgres/Storage = Wahrheit, lokales Volume = wegwerfbarer Cache.**

### Extraktions-Pipeline heute (`server/tasks/enrich.ts`)

Läuft beim Hintergrund-Crawl (nicht lazy), generisch über alle Crawler:
Rules → Text-LLM → **Vision-LLM-Fallback** (PR #115). Gescannte Bild-PDFs
werden erkannt (pdftotext liefert < 200 Zeichen → `SCANNED_PDF_TEXT_THRESHOLD`),
die erste Seite via `pdfPageToBase64Jpeg` (pdftoppm) gerendert und als
Image-Block an das LLM geschickt (`haex-claude-proxy` unterstützt das bereits).

**Das vom Nutzer genannte Bild-PDF-Problem ist also im Kern schon gelöst** —
zu prüfen/erweitern bleibt: (a) nur die erste Seite wird gerendert (Fotos/Werte
auf späteren Seiten fehlen), (b) der 200-Zeichen-Heuristik-Schwellwert, (c) ob
gescannte PDFs auch als Galerie-Fotos taugen (bewusst noch nicht).

Aktuell extrahierte Felder (`AuctionExtraction`): `propertyType`, `landAreaSqm`,
`livingAreaSqm`, `rooms`, `units`, `photos`. **Fehlt:** Zustand/Ausstattung
(uncommitted, s.u.), Preise/Termine über den Verkehrswert hinaus.

### Verlorenes Feature: Zustand + Ausstattung

Fertig gebaut + getestet, aber **nie committed**. Liegt als uncommitted diff im
Worktree `.claude/worktrees/extraction-condition-features` (Basis-Commit
`d633780` — **weit hinter main `ffb573a`**). Neue Dateien `lib/condition.ts`,
`lib/features.ts` sind da; geändert: `types/auction.ts`, `enrich.ts`, `llm.ts`,
`pages/index.vue`, `pages/objekt/[platform]/[id].vue`, i18n u.a. Weil seither
`enrich.ts`/`llm.ts`/`types/auction.ts` durch PRs #114–#122 (Vision-Fallback,
LLM-Cap, Länder-Pause, current-auctions) stark verändert wurden, lässt sich der
diff **nicht einfach committen — er muss auf aktuellem main neu angewandt
werden** (Konflikte v.a. in enrich.ts/llm.ts sind sicher).

---

## 2. Zielbild (für DE)

1. **Supabase ist alleinige persistente Wahrheit.** Lokales Volume nur noch
   ephemerer Cache (löschbar ohne Datenverlust).
   - Strukturierte Daten: Serving-Endpoints lesen aus Postgres `auctions`.
   - Bilder: in privatem Supabase Storage, ausgeliefert über `/api/auction-image`
     mit kurzlebiger Signed URL.
   - Extraktion: in Postgres persistiert; LLM muss nach Volume-Verlust nicht neu laufen.
2. **LLM extrahiert alles Nötige:** Objektart, Wohn-/Grundstücksfläche, Zimmer,
   **Zustand** (baufällig, Denkmalschutz, Sanierungsbedarf, Schimmel, Statik …),
   **Ausstattung**, Bilder, **Preise** (Verkehrswert + geringstes/Mindestgebot,
   Sicherheitsleistung), **Termin**, Adresse + Geokoordinaten. Robust bei
   Text-PDFs **und** reinen Bild-PDFs (Vision).
3. **Frontend zeigt alles sauber**, Beschreibung/Übersetzung live DE/EN (schon da).
4. **DE-Datenbestand einmal vollständig durchgezogen:** gecrawlt, roh archiviert,
   komplett LLM-geparst.

---

## 3. Design-Entscheidungen (beschlossen 2026-07-22)

### E1 — Read-Path: Postgres als Serving-Quelle ✅ BESCHLOSSEN
**Ja, Serving-Endpoints auf Postgres `auctions` umstellen; lokales Volume nur
noch wegwerfbarer Cache.** Das ist
der definierende Migrationsschritt. Um die Frontend-Änderung klein zu halten,
liest `/api/auctions` zunächst die (DE-)Liste aus Postgres und liefert sie wie
bisher; das **client-seitige Filtern (`lib/auction-filters.ts`) bleibt vorerst**.
Server-seitiges WHERE-Filtern/Pagination ist ein späterer, separater Schnitt.

### E2 — Reprocessing-Modell: entkoppeltes Parsen aus dem Archiv ✅ BESCHLOSSEN
Der Nutzer-Wunsch ("erst crawlen+speichern, dann LLM über die gespeicherten
Daten") entspricht nicht dem heutigen gekoppelten Pfad (fetch+archive+parse in
einem Lauf). **Ein leichtgewichtiger Reprocessing-Task, der PDFs/
HTML aus dem plain-S3-Roh-Archiv liest statt live von den Portalen.** Grund: Beim
"ein Land sauber machen" iteriert man die LLM-Extraktion mehrfach (neue Felder,
bessere Prompts) — gegen das eingefrorene Archiv statt gegen Live-Portale
(Rate-Limits/Captcha/Portal-Änderungen). Der gekoppelte Pfad bleibt für den
Erst-Crawl; Reprocessing ist der Iterations-Hebel. (Entspricht dem früher
deferten WP-18.)

### E3 — Bilder: Bucket-Strategie ✅ BESCHLOSSEN
**Eigener privater Storage-Bucket `zvg-immo-images`.** Aus PDFs/HTML extrahierte
Bilder können Ausschnitte mit personenbezogenen oder urheberrechtlich sensiblen
Details enthalten; public-read ist daher erst nach einer expliziten Sanitizing-
und Freigabeentscheidung zulässig. Auslieferung erfolgt über kurzlebige Signed
URLs hinter `/api/auction-image`; Löschung/Retention folgt dem Lebenszyklus der
zugehörigen Auktion bzw. einer erneuten Extraktion. Getrennt vom immutablen
Roh-Archiv (anderer Lebenszyklus: Bilder können neu extrahiert/ersetzt werden).

### E4 — "Fees" vs. bestehender Kostenrechner
Gerichtskosten/Grunderwerbsteuer werden bereits im Kostenrechner
(`lib/auction-costs.ts`) berechnet. **Empfehlung:** keine doppelte Extraktion —
neu extrahiert werden nur **auktions-spezifische** Werte: geringstes/Mindestgebot
und Sicherheitsleistung, falls in der Bekanntmachung genannt. Für ZVG gibt es
keinen "aktuellen Preis" wie bei Online-Auktionen (Live-Bieten am Gerichtstermin).

---

## 4. Arbeitspakete (Abhängigkeitsreihenfolge)

Jedes WP = eigener Worktree/Branch, endet grün (tsc + Tests), eigener PR,
review-gated (nie autonom mergen).

### WP-1 — Zustand + Ausstattung neu als PR *(zuerst, entkoppelt)* ✅ FERTIG
**Status (23.07.2026): PR #123, GEMERGT.** Historische Umsetzung: Auf aktuellem
main neu portiert (nicht den alten `d633780`-Diff blind gemergt — main war 4
Commits weiter: Vision-Fallback #115, current-auctions #117, LLM-Cap-Config
#116, Per-Platform-Quota #102).
- Neue Felder `condition`/`features` in `AuctionExtraction` (`types/auction.ts`),
  `lib/condition.ts` + `lib/features.ts` (Vokabular + Tests) übernommen.
- LLM-Schema/Clamp/Prompt (`llm.ts`) + Backfill-Logik in `enrich.ts` auf den
  neuen enrich.ts-Stand neu portiert (`needsConditionFeaturesBackfill`,
  gebounded durch denselben `MAX_LLM_FAILURES`-Zähler wie `needsLlmRetry`).
- Filter (`lib/auction-filters.ts`), i18n, Card-Badges, Detail-Grid (Zustand+
  Ausstattung ersetzen die bisherige Premium-Platzhalter-Sektion).
- **Verifikation:** 649 Tests grün, tsc sauber.
- *Referenz:* [[extraction-condition-features-plan]] (Memory).

### WP-2 — Preis/Termin-Felder (geringstes Gebot, Sicherheitsleistung) ✅ FERTIG, Scope erweitert
**Status (23.07.2026): PR #124, GEMERGT.** Vor der Umsetzung gegen
echte zvg-portal.de-Bekanntmachungen verifiziert (Liste+Detail-HTML+PDF-
Anhänge, mehrere Bundesländer) — Ergebnis widerspricht der Prämisse dieses
Abschnitts: **"geringstes Gebot" wird in Deutschland nie vorab veröffentlicht**
(gesetzlich erst live im Termin aus den bis dahin angemeldeten Rechten
berechnet), **"Sicherheitsleistung" ist fast immer nur die implizite
10%-Regel** (§ 68 Abs. 3 ZVG) ohne bezifferten Betrag im Text. Das geplante
Feld `lowestBid` als Zahl wurde daher **nicht** umgesetzt (wäre für DE fast
immer null).

Auf Nutzer-Wunsch stattdessen **europaweit** gedacht: andere Länder haben echte
Start-/Mindest-/aktuelle Gebote (Online-Bieter-Plattformen statt
Präsenz-Gerichtstermin). Ein Vollaudit aller 26 Crawler fand 8 Plattformen mit
bereits geparsten, aber bisher verworfenen/kollabierten Preisfeldern: Biddit
(Belgien), si (Slowenien), fi (Finnland), hu (Ungarn), pl (Polen), boe
(Spanien), ca (Ontario), us-bid4assets — alle additiv verdrahtet, ohne die
bestehende `marketValue`-Logik anzutasten.
- `Auction.startingBid`/`currentBid`/`sourceSecurityDeposit` (native Währung,
  wie `marketValue`/`currency`) statt eines AuctionExtraction-Felds — das sind
  strukturierte Plattformdaten, keine LLM-Prosa-Extraktion.
- `AuctionExtraction.securityDeposit` (Rules-Pass + LLM-Fallback, nur bei
  explizit genanntem Betrag, nie aus einem Prozentsatz berechnet) +
  `biddingNotes` (LLM-only, kein eigener Backfill-Mechanismus — zu selten).
- **Verifikation:** 667 Tests grün, tsc sauber.
- *Referenz:* [[price-bid-fields-wp2]] (Memory).

### WP-3 — Extraktions-Persistenz in Postgres (Volume wird wegwerfbar)
Voraussetzung dafür, dass ein Volume-Verlust keinen LLM-Neulauf erzwingt.
- `auctions`-Tabelle um die neuen Spalten aus WP-1/WP-2 erweitern (condition,
  features als jsonb/text[], starting_bid, current_bid,
  source_security_deposit, security_deposit, bidding_notes — s. WP-2s
  tatsächliche Feldnamen statt der ursprünglich geplanten lowest_bid).
- `enrich.ts` liest den Extraktions-Cache **beim Start aus Postgres** (statt nur
  aus `.cache_zvg/extraction.json`) bzw. schreibt ihn dorthin durch. Lokale JSON
  bleibt optionaler Schreib-Cache.
- **Verifikation:** Volume leeren, enrich starten → keine erneuten LLM-Calls für
  bereits extrahierte Auktionen.

### WP-4 — Bilder nach Supabase Storage ✅ FERTIG (Code-Seite)
**Status (23.07.2026): PR #125, GEMERGT.** Parallel zu WP-1/WP-2
begonnen (DAG-unabhängig). Anders als ursprünglich geplant bleibt
`/api/auction-image` der stabile Endpoint (keine `kong.yml`-Änderung nötig —
die `storage-v1`-Route ist bereits generisch für alle Buckets, kein
Bucket-spezifisches Routing):
- `NUXT_IMAGES_BUCKET` (server-only Runtime-Config + `docker-compose.yml`),
  eigener Bucket getrennt von `NUXT_STORAGE_BUCKET` (raw-archive).
- `server/utils/image-storage.ts`: `uploadImage()` (best-effort, wie
  `storage-uploader.ts`) + signed/private Read-URL-Helfer.
- `enrich.ts`: frisch extrahierte Fotos zusätzlich unter
  `<platform>/<externalId>/<filename>` hochgeladen.
- `/api/auction-image`: lokaler Cache zuerst, bei Cache-Miss Redirect (302)
  auf eine kurzlebige Signed URL, sonst 404 — Frontend (`extraction.photos`/
  `thumbnailUrl`) unverändert, da es weiterhin `/api/auction-image/...`-URLs
  synthetisiert.
- **Verifikation:** tsc sauber, 656 Tests grün. Bucket-Anlage selbst
  (privat, einmaliger Infra-Schritt) sowie Backfill bereits extrahierter lokaler Fotos sind
  **bewusst nicht** Teil dieses PRs (Backfill eher WP-6-Thema).

### WP-5 — Read-Path auf Postgres umstellen *(der Kern-Migrationsschritt)*
- `/api/auctions`, `/api/auctions-geo`, `/api/auction/[platform]/[id]`,
  `/api/data/v1/*` lesen aus Postgres `auctions` statt aus dem JSON-Snapshot.
- Client-seitiges Filtern zunächst unverändert (Liste kommt jetzt aus der DB).
- JSON-Snapshot/Extraktions-Cache werden zu reinen Ableitungen (oder entfallen).
- **Verifikation:** komplettes Volume gelöscht → App liefert DE-Daten unverändert
  aus Supabase; Suchseite + Detailseite identisch zu vorher.

### WP-6 — Reprocessing-Task (Parsen aus dem Archiv) *(E2)* ✅ #129 GEMERGT
- Neuer Task, der pro DE-Auktion die neuesten `raw_captures` (PDF/HTML) aus
  dem plain-S3-Roh-Archiv lädt und `extractByRules`/`extractByLlm` (inkl. Vision) darauf
  laufen lässt — **ohne Live-Fetch**.
- Ermöglicht LLM-Iteration + Nachziehen neuer Felder ohne Portal-Last.
- **Verifikation:** Reprocessing einer bekannten Bild-PDF-Auktion (zvg-portal/7265)
  liefert dieselben Werte wie der Live-Pfad.

### WP-7 — Vision-Extraktion härten (optional, bei Bedarf)
Nur falls WP-6/DE-Durchlauf Lücken zeigt:
- Mehrseitige Bild-PDFs (heute nur Seite 1 gerendert).
- Schwellwert-Heuristik (200 Zeichen) gegen reale DE-PDF-Stichprobe kalibrieren.

### WP-8 — Frontend-Feinschliff
- Zustand-Badges/Ausstattungs-Chips (aus WP-1), Preis-/Gebots-Block (WP-2),
  Bild-Galerie aus Supabase (WP-4), Bild-PDF-Werte sichtbar.
- Beschreibung/Übersetzung DE/EN läuft bereits (WP-8 i18n, PR #98).
- **Verifikation:** Detailseite einer reichen DE-Auktion zeigt alle Felder.

### WP-9 — Voller DE-Durchlauf (Ausführung, kein Code)
- DE-Crawl komplett laufen lassen → Roh-Archiv in Postgres + plain S3 füllen
  (`raw_blobs`/`raw_captures` + S3-Objekte).
- Vollständige LLM-Enrichment über alle DE-Auktionen (LLM-Cap temporär hoch,
  `NUXT_EXTRACT_LLM_MAX_PER_RUN`, PR #116) — Vision-aware.
- **Verifikation:** Stichproben-Audit: Anteil `source:'llm'`, Felddeckung
  (Fläche/Zimmer/Zustand/Bilder), Bild-PDFs korrekt geparst.

---

## 5. Reihenfolge / DAG

```
WP-1 (Zustand/Ausstattung) ─┐
WP-2 (Preis/Termin) ────────┼─→ WP-3 (Extraktion→Postgres) ─→ WP-5 (Read-Path→Postgres) ─┐
                            │                                                             ├─→ WP-9 (DE-Durchlauf)
WP-4 (Bilder→Storage) ──────┴─────────────────────────────────→ WP-6 (Reprocessing) ─────┘
                                                                 WP-7 (Vision härten, opt.)
                                                                 WP-8 (Frontend) ─────────→ (nach WP-1/2/4/5)
```

- **WP-1 zuerst und allein** (verlorene Arbeit, entkoppelt).
- WP-3 braucht die Felder aus WP-1+WP-2. WP-5 braucht WP-3+WP-4.
- WP-6 kann parallel zu WP-5 (beide brauchen nur WP-3/WP-4).
- WP-9 ist reine Ausführung, ganz am Ende.

**Update (2026-07-23): WP-1 bis WP-6 (#123-#129) inzwischen alle gemergt** — siehe
Status-Hinweis ganz oben im Dokument, weitere Arbeit läuft im Nachfolgeplan
`docs/plans/2026-07-22-de-crawler-photos-cards-plan.md`.

**Status (23.07.2026): WP-1 bis WP-6 (#123-#129) alle GEMERGT** — siehe
Status-Hinweis ganz oben im Dokument.

---

## 6. Risiken / Fallen

- ~~**Worktree-Rebase WP-1:** alter diff auf `d633780`, main ist weit voraus —
  nicht blind committen, neu portieren.~~ Erledigt (PR #123) — neu portiert,
  nicht blind gemergt.
- **Kong-Neustart** nach neuem Bucket/Route zwingend (kein Hot-Reload — siehe
  [[supabase-storage-buckets-unused]]).
- **Postgres-Init-Skripte laufen nur einmal** — Schema-Änderungen (neue Spalten)
  müssen idempotent (`ADD COLUMN IF NOT EXISTS`) sein und ggf. manuell gegen die
  Prod-DB gefahren werden.
- **Read-Path-Umstellung (WP-5)** ist der riskanteste Schnitt: client-seitiges
  Filtern hängt heute am vollständigen Snapshot. Erst DB-Liste 1:1 liefern,
  server-seitiges Filtern separat.
- **`useRuntimeConfig` in Tests** nicht global — in neuen Tests stubben (bekannte Falle).
- **Nominatim-Geocoding** auf Server-IP teils 429 (siehe [[nominatim-429-server-ip]]) —
  betrifft neue Adressen; für DE meist unkritisch, im DE-Durchlauf beobachten.
```
