# DE-Crawler-Offensive: Fotos, Extraktion, Premium-Cards

Datum: 2026-07-22
Fokus: Deutschland (`zvg-portal`). Die Extraktions-/Frontend-Änderungen sind
plattformübergreifend, das Debugging/Verifizieren erfolgt an DE.

## Entscheidungen (mit Nutzer abgestimmt)

- **Premium-Cards:** Sperre (Crown/Blur-Overlay) entfernen, echte Daten für alle
  sichtbar. Gating später separat.
- **Baujahr/Sanierung:** beide als numerischer Jahr-Bereich (`yearBuilt`,
  `lastRenovationYear`), Min/Max-Filter wie Wohnfläche; zusätzlich kurzer
  Freitext `renovationNotes` für die Card.
- **Bilder-Sortierung:** „mit Fotos zuerst" nur in der Standard-Sortierung; bei
  Preis/Datum bleibt die Nutzerwahl unangetastet.
- **Extraktionsprinzip:** Aus **jedem** Dokument alle Fotos **und** Infos in
  bester Qualität holen. Deterministische Tools (poppler, tesseract) wo sie
  reichen, **Vision-LLM** wo nicht — für Text *und* für Bilder gleichermaßen.
- **Extraktions-Architektur:** Dokument-zentrische Pipeline statt inkrementellem
  Feld-für-Feld-Nachziehen — jedes Dokument wird **einmal** fetchen, **einmal**
  normalisiert (Roh-Text+Bilder, deterministisch), **einmal** ans (multimodale)
  LLM gegeben.
- **LLM-Provider: Gemini Flash statt Claude-Proxy** (contingent auf Bake-off).
  Der haex-claude-proxy läuft heute auf einem Claude-Abo (flat, aber
  rate-limitiert + ToS-Grauzone für Server-Backends; ein europaweiter Backfill
  sprengt die Abo-Limits). Gemini Flash über eine metered API ist das robustere
  Fundament. **Bulk (enrich + reprocess) über die Gemini Batch-API** (50 %
  Rabatt, ~24 h SLA — für Hintergrund-Anreicherung unkritisch), **On-Demand
  (Detailseiten-Summary) synchron** über Gemini. Claude-Proxy wird erst
  abgeschaltet, wenn der Bake-off die Qualität bestätigt.
- **Provider-Naht:** LLM-Client in `server/utils/extract/llm.ts` hinter ein
  schmales Interface legen (Provider = Config), damit ein späterer Wechsel/
  Zusatz-Provider ein Config-Change bleibt — Optionalität durch Abstraktion,
  nicht durch parallel betriebene Provider.
- **Natives PDF (Gemini):** aktuelle Flash-Generation kann rohe PDFs direkt
  verarbeiten (eigenes OCR/Layout) → kann den Scan-Zweig (tesseract +
  Seiten-Rendering) in Stufe 1 potenziell ersetzen. Am Bake-off verifizieren.
  Für die *Anzeige* der Fotos bleibt `pdfimages` (Bilddateien extrahieren)
  nötig; Gemini übernimmt Kuratierung/Caption.
- **OCR-Fallback für Scans:** falls doch nötig (oder solange Claude-Pfad läuft):
  Tesseract zuerst (lokal, kostenlos), Vision-LLM als Fallback bei zu dünnem
  OCR-Ergebnis. Bei nativem Gemini-PDF-Weg entfällt das.
- **Foto-Kuratierung:** cheap Heuristik-Vorfilter (Größe/Deckblatt/Wappen) +
  **Vision-LLM-Kuratierung** der verbleibenden Kandidaten (echtes Objektfoto vs.
  Lageplan/Grundriss/Logo/Textseite, mit Kategorie & Caption). Zustand/Ausstattung
  werden auch aus den Fotos abgeleitet, nicht nur aus dem Text.
- **Rules-Layer:** deterministische Rules + Plattform-Strukturwerte bleiben als
  Merge (gewinnen wo vorhanden), sind aber **kein Gate** mehr, das den LLM-Call
  überspringt.

---

## Problem-Analyse (Ist-Zustand)

### Item 1 — Fotos fehlen in Übersicht und Detail

Zwei getrennte, sich gegenseitig ausschließende Foto-Pfade:

1. **Foto.pdf-Anhang vorhanden** → `applyDetail` (`server/crawlers/zvg-portal/index.ts:13-17`)
   setzt `thumbnailUrl = /api/zvg-thumb?…` aus dem *ersten* Foto-Anhang. Dieser
   Thumbnail wird **live** aus dem PDF gerendert (`server/api/zvg-thumb.get.ts`),
   liegt nur im lokalen Disk-Cache, wird **nicht** nach Supabase gespiegelt und
   ist **nicht** dauerhaft.
2. **Kein Foto.pdf, aber Gutachten** → Enrich-Task schürft eingebettete Bilder
   (`extractPdfPhotos`, `server/utils/extract/pdf-images.ts`) → `.cache_zvg/images`
   → Supabase-Mirror (WP-4) → Dateinamen in `extraction.photos`.

**Warum Fotos fehlen:**
- Die Übersicht (`/api/auctions`, `server/api/auctions.get.ts`) überlagert nur
  den **Verkehrswert-** und den **Extraction-Cache**. Der Extraction-Overlay
  synthetisiert `thumbnailUrl`/`photoCount` **ausschließlich aus
  `extraction.photos`** (PDF-geschürfte Bilder, `server/utils/extraction-cache.ts:33-44`).
  Der `auction_snapshot` (wo native Foto-Anhänge/`zvg-thumb`-Thumbnails und
  `photoUrls` liegen) wird **nie** überlagert. → Auktionen, deren Foto nur aus
  einem Foto.pdf stammt, zeigen in der Übersicht **kein** Thumbnail.
- Das PDF-Mining ist auf `photoCount === 0` gated (`server/tasks/enrich.ts:431`).
  Auktionen mit Foto.pdf bekommen also *nie* dauerhafte, gespiegelte Bilder.
- Der Foto-Pipeline-Lauf passiert nur einmal beim ersten Cache-Eintrag, ohne
  Retry (`enrich.ts:406-414`). Einträge, die vor WP-4 oder bei einem PDF-Fehler
  entstanden, haben `photos === undefined` und werden nie nachgezogen.

### Item 2 — Fotos-zuerst-Sortierung

`pages/search.vue` sortiert client-seitig (`sortedList`, `sortBy` ∈
`default|dateAsc|priceAsc|priceDesc`). Solange die Übersicht keine verlässlichen
`photoCount`/`thumbnailUrl` hat (siehe Item 1), ist „Fotos zuerst" nicht
umsetzbar → Item 2 hängt an Item 1-Fix.

### Item 3 — Baujahr/Sanierung fehlen als Extraktionsfeld/Filter

`AuctionExtraction` (`types/auction.ts:122-164`) kennt kein `yearBuilt`/
`renovation`. Feld-Hinzufügen ist ein mechanischer, gut dokumentierter Pfad
(Typ → LLM-Schema/Prompt → Clamp → optional Rules-Regex → DB-Spalte →
current-auctions-Mapping → Filter-Logik → Filter-UI → i18n).

### Item 4 — Beschreibung zu kurz, Gutachten wird nicht aufgegriffen

`Auction.description` ist reiner Crawler-Scrape. Der Gutachten-PDF-Text wird per
`pdfToText` extrahiert, aber:
- nur die **ersten ~12.000 Zeichen** gehen ins LLM (`MAX_PDF_CHARS`, `llm.ts:54`),
- der Text landet **nur** im Disk-Cache (`.cache_zvg/pdftext`), **nicht** in
  Postgres → bei frischem Container verloren, und wird nirgends im UI angezeigt.

Beispiel: [Objekt 48639](https://zvg.haex.cloud/objekt/zvg-portal/48639) hat ein
seitenlanges Gutachten, dessen Inhalte komplett fehlen.

### Item 5 — Premium-Cards sind leere Skeletons

`components/PremiumFeatureLock.vue` rendert nur Skeleton-Balken hinter
Crown/Blur. Betroffen (Detailseite `pages/objekt/[platform]/[id].vue`):
Grundbuch, Flurstücke, Mängel, Belastungen, Bodenrichtwert, Bau & Instandhaltung,
Lage-Charakteristik, Orte in der Nähe. Keine dieser Daten wird heute extrahiert.

### Item 6 — ICS-Button sieht anders aus

`pages/objekt/[platform]/[id].vue:403` nutzt `variant="ghost"` **ohne** Icon,
während die beiden Kalender-Buttons (`:393`, `:398`) `variant="outline"` mit
`<CalendarPlus>`-Icon nutzen.

---

## Zielarchitektur: Dokument-Pipeline

Ein Dokument (Gutachten-PDF, Detail-HTML, Anhang) durchläuft genau **drei
einmalige** Schritte. Kein Feld-für-Feld-Nachziehen mehr.

```
Dokument
  │  (0) FETCH — einmal je Content-Hash; schon durch raw_blobs/raw_captures
  │      archiviert (content-addressed), Re-Fetch entfällt.
  │
  ├─ (1) NORMALISIEREN  — deterministisch (kein LLM außer OCR-/Bild-Fallback):
  │      PDF digital → pdftotext -layout (Text)  +  pdfimages (Roh-Bilder)
  │      PDF Scan    → tesseract OCR (Text)       +  Seiten-Raster
  │                    └ OCR zu dünn → Vision-LLM-Fallback (Seite als Bild)
  │      HTML        → html→text/markdown
  │      Roh-Bilder → cheap Heuristik-Vorfilter (Größe/Deckblatt/Wappen)
  │                    ⇒ Kandidaten-Bild-Set
  │      ⇒ EIN kanonischer Text  +  Kandidaten-Bilder
  │      ⇒ DURABEL: Text als derived-Blob (raw-archive-Bucket), Bilder
  │        (images-Bucket, WP-4). Damit nie erneut OCR/pdftotext/pdfimages nötig.
  │
  └─ (2) STRUKTURIEREN & KURATIEREN — EIN multimodaler LLM-Call
         (kanonischer Text + Kandidaten-Bilder, herunterskaliert, Anzahl gedeckelt):
         umfassendes Schema, alles auf einmal:
           • Info-Felder (Objektart, Flächen, Baujahr, Sanierung, Mängel,
             Belastungen, Bodenrichtwert, Bau/Lage, Summary)
           • Foto-Kuratierung je Bild: {isPropertyPhoto, category, caption}
           • condition/features — aus Text UND Fotos abgeleitet
         Rules/Plattform-Strukturwerte als Merge obendrauf.
         ⇒ strukturiertes JSON nach Postgres; kuratierte Fotos = Anzeige-Set.
```

**Warum das die „Mehrfach-Lesen"-Frage löst:** neue Felder später brauchen
höchstens *einen* Reprocess — und der läuft über den **gespeicherten
kanonischen Text + Kandidaten-Bilder** (Schritt 1-Output), nicht über Re-Fetch,
nicht über erneute OCR/Bildextraktion. Heute liegt der extrahierte Text nur im
flüchtigen Disk-Cache (`.cache_zvg/pdftext`), weshalb jeder Reprocess die
Textextraktion neu macht — das Durable-Ablegen in Schritt 1 behebt genau das.

**Deterministisch (ohne LLM):** Roh-Text + Roh-Bilder (poppler; Scans +
tesseract), plus der cheap Heuristik-Vorfilter der Bilder.
**LLM (multimodal, ein Call):** Strukturieren der Prosa (Mängel, Belastungen,
Bodenrichtwert, Zustand …) **und** Kuratieren/Kategorisieren der Kandidaten-Bilder
(echtes Objektfoto vs. Lageplan/Grundriss/Logo). Deterministische Rules schaffen
nur triviale Felder (Objektart/Fläche/Baujahr-Regex) und bleiben als Merge.

## Umsetzung (Work Packages)

Jedes WP ist ein eigener PR ab `main` (neuer Worktree/Branch). Vor jedem WP:
`git fetch` + ff-merge von `origin/main` (lokaler Drift, siehe Memory).

### WP-0 — Bake-off: Provider + Tool-Wahl *(Gate, vor WP-B/C)*

**Ziel:** Die zwei offenen Werkzeug-Entscheidungen an echten Daten klären, bevor
Infrastruktur gebaut wird.

1. **Provider:** Gemini Flash vs. Claude Haiku (aktueller Proxy) an ~10–20
   echten DE-Gutachten (born-digital **und** Scans) — gemessen an *unseren*
   Feldern: Baujahr, Mängel, Belastungen, Bodenrichtwert, Zustand/Ausstattung,
   **Foto-Kuratierung**. Metriken: Feld-Trefferquote, Foto-Kuratierungsqualität,
   Latenz, Kosten/Dokument.
2. **PDF→Text:** poppler `pdftotext -layout` vs. Gemini natives PDF (bzw.
   optional docling) als LLM-Input — entscheidet, ob der tesseract/Render-Zweig
   in Stufe 1 überhaupt gebraucht wird.

**Ergebnis:** Provider + Stufe-1-Toolchain festgelegt. Erst danach WP-B/C bauen.

---

### WP-A — ICS-Button angleichen *(trivial, Quick Win, Item 6)* ✅ #131 GEMERGT

- `pages/objekt/[platform]/[id].vue:403`: `variant="ghost"` → `variant="outline"`,
  Leading-Icon (`<CalendarPlus class="h-4 w-4" />`) vor dem Label ergänzen.

**Verifikation:** drei Buttons optisch konsistent.

---

### WP-B — Pipeline Schritt 1: Normalisierung durabel *(Fundament)*

**Ziel:** Aus jedem DE-Dokument entstehen einmalig ein kanonischer Text und ein
Bild-Set, beide durabel gespeichert.

1. **Normalisierer** — neuer `server/utils/extract/normalize.ts`, der pro
   Dokument entscheidet: digital (pdftotext-Text ≥ Schwelle) vs. Scan. Digital →
   `pdftotext -layout` + `pdfimages` (vorhandene Utils `pdf-text.ts`/`pdf-images.ts`).
   Scan → **tesseract** (neues Binary im Container-Image); wenn OCR-Ergebnis unter
   Schwelle bleibt → bestehender Vision-Pfad `pdfPageToBase64Jpeg` als Fallback.
   HTML → einfache html→text/markdown-Konvertierung.
2. **Kanonischer Text durabel** — den normalisierten Text als *derived*-Blob im
   raw-archive-Bucket ablegen (eigener `kind`/Präfix, content-addressed), damit
   Reprocessing ihn ohne erneute OCR liest. (Schließt die im Read-Path-WP-5
   angemerkte Lücke „extrahierter Text nicht in Postgres/Bucket".)
3. **Kandidaten-Bilder** — `pdfimages`/Raster in `.cache_zvg/images` + Supabase
   images-Bucket (WP-4-Pfad); cheap Heuristik-**Vorfilter** (`pdf-images.ts`:
   Seite-1-Cover, min 400×300, Wappen) reduziert nur offensichtlichen Müll und
   liefert die Kandidatenmenge — die eigentliche Kuratierung (Objektfoto vs.
   Lageplan/Grundriss) macht das Vision-LLM in WP-C. Filter daher **konservativ**
   halten (lieber ein Kandidat zu viel als ein echtes Foto verwerfen).

**Verifikation:** für ~10 DE-Auktionen liegen kanonischer Text + Kandidaten-Bilder
im Bucket; ein zweiter Lauf erzeugt (gleicher Content-Hash) keine erneute
OCR/Bildextraktion. Unit-Test für die digital/Scan-Weiche.

**Status:** Item 2 (kanonischer Text durabel) ✅ **#133 GEMERGT**
(`archiveDocumentText`/`kind='document_text'`). Item 1 (Normalisierer mit
digital/Scan-Weiche + **tesseract**) wurde **nie gebaut** — der WP-0-Bake-off
(siehe Memory) ergab, dass natives Gemini-PDF (C.3, `GeminiNativeProvider`)
Scans direkt liest und den tesseract-Zweig überflüssig macht; bewusst nicht
mehr nachgeholt. Item 3 (Kandidaten-Bilder-Vorfilter) existierte als
Größen-Heuristik (`pdf-images.ts`, min. 400×300) bereits vor diesem Plan;
C.6 ergänzte den Anzahl-Deckel (`MAX_CANDIDATE_PHOTOS=8` in `enrich.ts`) —
kein Downscaling der Bildgröße (offener Punkt, s.u.), keine Wappen-Erkennung.

---

### WP-C — Pipeline Schritt 2: EIN multimodaler LLM-Call *(Items 1+3+4+5, Extraktion)*

**Ziel:** Ein multimodaler LLM-Call pro Dokument liefert **alle** Info-Felder
**und** die Foto-Kuratierung; durabel in Postgres.

1. **`AuctionExtraction` erweitern** (`types/auction.ts`):
   - `yearBuilt: number | null`, `lastRenovationYear: number | null`,
     `renovationNotes?: string | null` (Item 3).
   - `insights?: AuctionInsights | null` (Item 4+5): `defects: string[]`
     (Mängel), `encumbrances: string[]` (Belastungen/Abt. II),
     `landValueEurPerSqm: number | null` (Bodenrichtwert), `construction:
     string | null` (Bau & Instandhaltung), `locationCharacter: string | null`
     (Lage), `summary: string | null` (2–4 Sätze Gutachten-Kernaussage).
   - `photos`-Struktur anreichern: statt bloßer Dateinamen je Bild
     `{ file, category, caption }` (category z.B. `aussen|innen|grundriss|
     lageplan|sonstiges`); nur `isPropertyPhoto`-Bilder landen im Anzeige-Set,
     der Rest wird verworfen/markiert.
   Alle Felder nur bei Eindeutigkeit, sonst null/leer — kein Raten.
2. **Ein Schema, ein multimodaler Call** — `server/utils/extract/llm.ts`:
   `EXTRACTION_SCHEMA` um alle neuen Felder + das Bild-Kuratierungs-Array
   erweitern (+ `SYSTEM_PROMPT`, `ClampedExtraction`, `clampExtraction` mit
   Jahres-Plausibilität 1800…heute). Der Call bekommt **kanonischen Text +
   Kandidaten-Bilder** aus WP-B (nicht mehr nur die ersten ~12k Zeichen). Bilder
   herunterskalieren + Anzahl deckeln (z.B. Top-N) fürs Token-Budget;
   `MAX_PDF_CHARS` an realen Gutachten neu kalibrieren. Provider = **Gemini Flash**
   (JSON-`responseSchema` mit Zod statt `final_result`-Tool), Bulk über die
   **Batch-API** (Job einreichen → pollen → Ergebnisse einspielen; Request↔Auktion-
   Mapping, Teil-Fehler behandeln). Alles hinter der Provider-Naht, sodass der
   bisherige Claude-Pfad bis zum Bake-off-Ergebnis lauffähig bleibt.
3. **Rules als Merge, nicht als Gate** — `enrich.ts`/`reprocess.ts`: den
   „mergedConfident → LLM überspringen"-Zweig auflösen, sodass der LLM-Call für
   Dokumente immer läuft; Rules + Plattform-Strukturwerte gewinnen weiterhin, wo
   vorhanden. Optionale Baujahr-Regex in `rules.ts`.
4. **Durable Persistenz** — alles in `extraction_cache` (Postgres) als Teil von
   `AuctionExtraction`; fließt automatisch in `auction_snapshot` und den
   `/api/auctions`-Overlay. Kein neuer Store.
5. **DB-Spalten für Filter** — `schema.sql`: `year_built`, `last_renovation_year`
   (`ALTER TABLE auctions ADD COLUMN IF NOT EXISTS …`, + Index `year_built`);
   `current-auctions.ts` (`COLUMNS`/`CurrentAuctionRow`/`auctionToCurrentRow`).

**Verifikation:** für 48639 liefert der Call Baujahr, Mängel, Belastungen,
Bodenrichtwert, Summary **und** ein sauber kuratiertes Foto-Set (Lagepläne/Logos
aussortiert, echte Objektfotos mit Kategorie); `extraction` ist in der
API-Response und nach Container-Neustart persistent. Unit-Tests für
`clampExtraction` (Jahresgrenzen, Insights-Clamping, Foto-Kategorie-Whitelist).

#### WP-C Sub-Schritte (bei der Umsetzung entstanden — Reihenfolge = Risiko-aufsteigend)

WP-C wurde in kleine, einzeln reviewbare PRs gesplittet. Die additiven/
infrastrukturellen Schritte zuerst, das riskante „scharf schalten" (Anfordern +
Mergen, größere LLM-Antwort → Truncation-/Kosten-Risiko) bewusst zuletzt.

- **C.1 #135 ✅** Provider-Naht generalisieren (`ExtractionProvider`),
  Multi-Page-Vision-Fallback.
- **C.2 #136 ✅** `OpenAiCompatibleProvider` (Standard-Extraktionspfad, neuer
  Default; Providerwechsel = Config statt Deploy).
- **C.3 #137 ✅** `GeminiNativeProvider` (natives PDF-Verständnis, liest Scans
  ohne Rasterize/OCR). Foto-Kuratierung bewusst noch nicht verdrahtet
  (`candidateImages` leer, Antwortschema ohne `photos`/`photoIndex`).
- **C.4 #138 ⏳ (offen, reviewt)** `AuctionExtraction`-Schema **rein additiv**:
  `PhotoCategory`/`CuratedPhoto`/`AuctionInsights`; `yearBuilt`/
  `lastRenovationYear`/`renovationNotes`/`insights`; `photos: string[]` →
  `CuratedPhoto[]` (alte Zeilen via `normalizePhoto` am Read-Punkt gebrückt,
  keine Migration). `clampExtraction` klemmt Jahre+Insights (getestet). DB-
  Filter-Spiegel `year_built`/`last_renovation_year`. **`EXTRACTION_SCHEMA`/
  `SYSTEM_PROMPT` unverändert, enrich/reprocess mergen die Felder noch NICHT** —
  Klemm-Fähigkeit steht bereit, wird nur noch nicht befüllt.

- **C.5 ✅ — Anfordern (Schema + Prompt + Foto-Kuratierung scharf schalten).**
  Der LLM soll die neuen Felder **produzieren** — noch ohne sie in den
  persistierten `entry` zu mergen (das ist C.6), damit „Anfordern" und „Mergen"
  getrennt reviewbar bleiben.
  1. `EXTRACTION_SCHEMA` + `SYSTEM_PROMPT` (`server/utils/extract/llm.ts`) um
     `yearBuilt`/`lastRenovationYear`/`renovationNotes` und das `insights`-Objekt
     (defects/encumbrances/landValueEurPerSqm/construction/locationCharacter/
     summary) erweitern. Anweisung: nur bei Eindeutigkeit, sonst null/leer — kein
     Raten.
  2. Foto-Kuratierung verdrahten: `LlmInput.candidateImages` aus den Kandidaten-
     Bildern befüllen (indizierte Text-Parts / `photoIndex`), Schema um das
     `photos`-Kuratierungs-Array (`{file/photoIndex, category, caption,
     isPropertyPhoto}`) ergänzen; Bilder herunterskalieren + Anzahl deckeln
     (Top-N) fürs Token-Budget.
  3. **Token-Budget:** der `OpenAiCompatibleProvider`-Default `max_tokens: 512`
     reicht für die größere Antwort nicht → hochsetzen (+ `MAX_PDF_CHARS` an
     realen Gutachten neu kalibrieren), sonst Truncation.
  - **Erfolgskriterien:** (a) Für 48639 (+ 2–3 weitere DE-Gutachten) liefert
    `extractByLlm` ein Objekt, in dem `yearBuilt`, `insights.*` und ein
    kuratiertes `photos`-Array **befüllt** sind (per Test/Log gegen archivierte
    `raw_captures` verifiziert, kein Live-Fetch). (b) Keine abgeschnittene
    JSON-Antwort im gesamten Testset (max_tokens ausreichend). (c) `clampExtraction`
    reicht die neuen Felder korrekt geklemmt durch (bestehende Tests grün +
    Foto-Kategorie-Whitelist-Test). (d) enrich/reprocess-`entry` enthält die
    Felder **weiterhin nicht** (Merge erst C.6) — bewusste Scope-Grenze.
  - **Umsetzungsnotiz:** Fotokuratierung liefert ein **indexbasiertes**
    `ClampedExtraction.photoCuration` (`{photoIndex, category, caption,
    isPropertyPhoto}`), nicht direkt `CuratedPhoto[]` — der LLM kennt keine
    echten Dateinamen (siehe `LlmInput.candidateImages`-Kommentar), das
    Zusammenführen `photoIndex` → Dateiname passiert erst in C.6 beim
    Aufrufer. `max_tokens` auf 4096 angehoben (OpenAI-kompatibel + Claude-
    Proxy; Gemini-native setzt ohnehin kein `maxOutputTokens`). `MAX_PDF_CHARS`
    bewusst **nicht** angefasst — keine echten Gutachten-Daten in dieser
    Session zur Kalibrierung verfügbar, bleibt offener Punkt. Die beiden C.4-
    Follow-ups: (a) `clampInsights`-Null-Kollaps war bereits in #138 korrekt
    umgesetzt (keine Änderung nötig); (b) `biddingNotes` auf `trimmedString`
    vereinheitlicht — hier statt erst in C.6 erledigt, weil ohnehin an
    `clampExtraction` gearbeitet wurde.

- **C.6 ✅ — Mergen (der riskante, zuletzt platzierte Schritt).** Die angeforderten
  Felder in den persistierten `entry` übernehmen.
  1. `mergeLlmFields` in `enrich.ts`/`reprocess.ts`: `yearBuilt`/`lastRenovationYear`/
     `renovationNotes`/`insights`/kuratierte `photos` aus dem LLM-Ergebnis in den
     `AuctionExtraction`-`entry` mergen (Rules/Strukturwerte gewinnen weiter, wo
     vorhanden).
  2. **Rules als Merge, nicht als Gate**: den „mergedConfident → LLM überspringen"-
     Zweig auflösen, sodass der Call für Dokumente immer läuft.
  3. `needsInsightsBackfill` analog zu `needsConditionFeaturesBackfill`: Einträge
     ohne `insights` (undefined) für einen erneuten LLM-Lauf markieren. Aus
     demselben Grund auch `yearBuilt`/`lastRenovationYear` (undefined) mit
     abdecken — neue LLM-only-Felder mit derselben Backfill-Semantik.
  4. ~~Zwei Follow-ups aus dem C.4-Review~~ — **beide bereits in C.5 erledigt**
     (siehe C.5-Umsetzungsnotiz): `clampInsights`-Null-Kollaps war schon in
     #138 korrekt, `biddingNotes` nutzt jetzt `trimmedString`. Hier nichts
     mehr zu tun.
  - **Erfolgskriterien:** (a) Nach einem enrich/reprocess-Lauf auf 48639 trägt
    `extraction_cache` (und via Snapshot `/api/auctions`) die befüllten
    `insights`/`yearBuilt`/kuratierten `photos`; nach Container-Neustart
    persistent. (b) `clampInsights` mit leerem Input liefert `null` (neuer Test);
    `needsInsightsBackfill` greift genau bei fehlenden, nicht bei geprüft-leeren
    Insights. (c) Eintrag mit `insights===null` (geprüft, nichts) wird **nicht**
    erneut LLM-gebackfillt. (d) `biddingNotes`-Verhalten unverändert (bestehende
    Tests grün). (e) `vitest` + `nuxi typecheck` grün.
  - **Umsetzungsnotiz:** `needsConditionFeaturesBackfill` in `enrich.ts` zu
    `needsLlmFieldsBackfill` verallgemeinert (condition/features/yearBuilt/
    lastRenovationYear/insights in einer Prüfung statt separater Funktionen).
    Der `mergedConfident`-Gate ist in **beiden** Dateien aufgelöst
    (`reprocess.ts`s `!mergedConfident || needsConditionFeatures`-Bedingung
    war im Plan nicht explizit erwähnt, aber derselbe Gate — daher konsistent
    mitgelöst). **Foto-Kuratierung nur für frische Downloads/PDF-Extraktion**
    (`enrich.ts`, kein Prior-Entry): der Foto-Pipeline-Block läuft jetzt *vor*
    dem LLM-Call, ein gedeckelter Kandidaten-Satz (`MAX_CANDIDATE_PHOTOS = 8`,
    kein Downscaling — offener Punkt, siehe unten) geht als `candidateImages`
    mit; `photoIndex` → Dateiname-Zuordnung via neuem `applyPhotoCuration()`.
    Fotos aus einem Prior-Entry (Re-Run/Backfill) werden **nicht** erneut
    kuratiert — bewusst dieselbe Scope-Grenze wie `reprocess.ts`s
    „Photo re-extraction is out of scope" (dort gibt es ohnehin keine
    Foto-Pipeline, nur Merge der Text-Felder). Kein dediziertes
    `enrich.test.ts` vorhanden (vorbestehende Lücke) — Verhalten stattdessen
    über `reprocess.test.ts` (neuer Test: LLM läuft trotz confident
    Rules+Prior-Entry) und `llm.test.ts` abgesichert.

---

### WP-D — Serving & Frontend *(Items 1+2+3+5, Anzeige)*

**Ziel:** Fotos + neue Felder + Cards sichtbar; Foto-Objekte in Standard-Sort zuerst.

1. **Übersicht überlagert Snapshot-Fotodaten** (Item 1) —
   `server/api/auctions.get.ts`: `overlaySnapshotPhotos()` (analog Verkehrswert-/
   Extraction-Overlay) füllt `thumbnailUrl`/`photoCount`/`photoUrls` aus
   `readAuctionSnapshot()` in das Listen-Ergebnis. Behebt, dass die Übersicht
   heute nur PDF-geschürfte Fotos kennt (`extraction.photos`), nicht die
   Snapshot-Fotos. `read-path-postgres`-Test erweitern.
2. **Fotos-zuerst-Sortierung** (Item 2) — `pages/search.vue` `sortedList`:
   im `'default'`-Zweig `hasImages = (photoCount > 0 || !!thumbnailUrl)` als
   primären, absteigenden Schlüssel; Preis/Datum-Sorts unverändert.
3. **Filter-UI Baujahr/Sanierungsjahr** (Item 3) — `lib/auction-filters.ts`
   (`yearBuiltMin/Max`, `renovationYearMin/Max`, Filterblöcke klonen von
   `livMin/livMax`), `pages/search.vue` (Refs, `currentFilters`, URL-Sync,
   `activeFilterCount`, `clearAllFilters`), `components/search/SearchFilters.vue`
   (Bereichs-Inputs), i18n.
4. **Cards entsperren & befüllen** (Item 5) — `pages/objekt/[platform]/[id].vue`:
   `LOCKED_SECTIONS`/`PremiumFeatureLock`-Blöcke durch echte Anzeige aus
   `a.extraction.insights` ersetzen (Mängel-, Belastungen-Liste, Bodenrichtwert,
   Bau & Instandhaltung, Lage). Card nur rendern, wenn Daten vorhanden — kein
   Skeleton, keine erfundenen Inhalte, Sperr-Overlay weg.
5. **Beschreibung anreichern** (Item 4) — wo `description` kurz ist,
   `insights.summary` als „Zusammenfassung aus dem Gutachten" (klar als generiert
   gekennzeichnet) anzeigen; Summary-Endpoint kann Insights mitnutzen.
   - **Grundbuch/Flurstücke:** nur zeigen, wenn im Gutachten erkannt; kein Kern-Scope.
   - **Orte in der Nähe:** andere Datenquelle (POI via lat/lng), Follow-up
     (Nominatim-429-Risiko auf Server-IP, siehe Memory).

**Verifikation:** bekannte DE-Foto-Auktionen zeigen Thumbnails in Übersicht +
Detail; Standard-Sort listet Foto-Objekte oben; Baujahr-Filter schränkt korrekt
ein; 48639 zeigt gefüllte Cards.

**Status:** Items 1+2 ✅ **#134 GEMERGT** (Foto-Overlay + Fotos-zuerst-Sortierung).
Items 3+4+5 ✅ **#141 GEMERGT** (Baujahr/Sanierungsjahr-Filter,
Premium-Cards mit `insights` befüllt, `insights.summary` als
Beschreibungs-Ergänzung — inkl. Baujahr/letzte Sanierung zusätzlich in den
Eckdaten der Detailseite, da sonst ein filterbares Feld nirgends sichtbar
gewesen wäre). Grundbuch/Flurstücke/Orte-in-der-Nähe wie geplant weiterhin
außerhalb des Scopes (Premium-Lock bleibt dort bestehen).

---

### WP-E — Reprocessing über DE *(Vorbereitung erledigt, voller Lauf steht aus)*

**Status (2026-07-23): #142 GEMERGT** — `reprocessAuction()` gab die archivierten
PDF-Bytes bei `provider=gemini-native` bisher nie als `pdfBytes` weiter, lief also
trotz nativem Provider weiterhin über `pdftotext`-Text (gekappt bei
`MAX_PDF_CHARS`). Jetzt gehen bei `gemini-native` die rohen PDF-Bytes direkt raus,
`pdftotext`/Seiten-Rendering werden übersprungen — Vorbedingung dafür, dass die
geplante 10-Auktionen-Stichprobe die tatsächlich beabsichtigte Architektur misst.
`enrich.ts` hat dieselbe Lücke, bewusst nicht mit angefasst (eigenständiges Thema).
Offen bleibt: Gemini ist in Prod noch nicht deployed (kein Key/Provider-Config in
ansible/Container) — nötig, bevor der volle Lauf gegen Prod-DB starten kann.

- Nach WP-B/C den `reprocess`-Task über die DE-Bestände laufen lassen: er liest
  den in WP-B gespeicherten kanonischen Text (kein Re-Fetch, keine erneute OCR)
  und füllt alle neuen Felder rückwirkend. Vorher an ~10 Auktionen Qualität +
  Token messen, dann gebudgetiert über `maxLlmPerRun` durchlaufen.

**Verifikation:** Bestands-Auktionen (inkl. 48639) haben nach dem Lauf
`insights`/Baujahr befüllt.

**Hinweis:** operativer Lauf gegen Produktionsdaten (Gemini-API-Kosten,
Prod-DB-Writes), kein reiner Code-PR — Umfang/Kosten der 10er-Stichprobe
vorher mit dem Nutzer abstimmen, bevor der volle Lauf gestartet wird.

---

## Reihenfolge & Abhängigkeiten

0. **WP-0** (Bake-off) — Gate: legt Provider (Gemini vs. Claude) + Stufe-1-Tools fest. ✅ erledigt (Ergebnis: Gemini + natives PDF, siehe Memory).
1. **WP-A** (ICS) — unabhängig, sofort (parallel zum Bake-off). ✅ **#131 GEMERGT**
2. **WP-B** (Normalisierung durabel) — nach WP-0; Fundament für WP-C und WP-E. ✅ Item 2 **#133 GEMERGT**, Item 1 obsolet (s.o.), Item 3 großteils vorbestehend.
3. **WP-C** (multimodaler LLM-Call, volles Schema, Gemini-Provider) — nach WP-B. ✅ C.1-C.6 alle **GEMERGT** (#135-#140).
4. **WP-D** (Serving/Frontend) — Foto-Overlay + Sort können parallel zu WP-C;
   Filter/Cards brauchen die WP-C-Felder. ✅ Items 1+2 **#134 GEMERGT**, Items 3+4+5 **#141 GEMERGT**.
5. **WP-E** (Reprocessing über Gemini-Batch) — zuletzt, wenn Pipeline + Schema stehen. Vorbereitung (natives PDF korrekt verdrahtet) **#142 GEMERGT** — nächster Schritt: 10er-Stichprobe lokal/read-only fahren, Kosten/Umfang mit dem Nutzer abstimmen, bevor ein voller Lauf gegen Prod-DB startet (Gemini muss dafür erst noch in Prod deployed werden).

## Offene Punkte / Kosten

- **Gemini-API-Key** als Server-Secret (Deploy-Repo `~/Projekte/ansible`) —
  bereits im Einsatz seit dem Bake-off. Claude-Proxy bleibt vorerst als
  Fallback stehen (echter Kosten-/Qualitätsvergleich gegen Claude steht noch
  aus, da dessen Abo-Spend-Limit beim Bake-off erschöpft war, siehe Memory).
- **Tesseract-Binary:** nicht mehr nötig — der Bake-off entschied sich für den
  nativen Gemini-PDF-Weg (C.3), der lokale OCR-Zweig wurde nie gebaut (s.
  WP-B-Status oben).
- **LLM-Kosten:** ein **multimodaler** Call je Dokument (größerer Text +
  Kandidaten-Bilder als Image-Tokens + reichhaltiger Output) — deutlich teurer
  als heute, im Sinne der „beste Qualität"-Vorgabe bewusst in Kauf genommen.
  Gedämpft durch Heuristik-Vorfilter und Bild-Anzahl-Deckel (kein
  Downscaling der Bildgröße — weiterhin offen); gebudgetiert über
  `maxLlmPerRun`. Vor Voll-Reprocessing (WP-E) an ~10 Auktionen Qualität +
  Token messen und `MAX_PDF_CHARS`/den Foto-Deckel ggf. kalibrieren — bislang
  nicht an echten Gutachten-Daten kalibriert.
- **Grundbuch/Flurstücke/Orte-in-der-Nähe:** bewusst außerhalb des Kern-Scopes,
  Premium-Lock bleibt dort bestehen (WP-D bestätigt).
