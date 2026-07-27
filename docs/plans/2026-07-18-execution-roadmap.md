# Ausführungs-Roadmap — session-große Teilpläne

**Status (2026-07-23): komplett abgeschlossen.** WP-1 (#89), WP-2 (#91), WP-3 (#92),
WP-4 (#93), WP-5 (#100+#101), WP-6 (#94), WP-7 (#96+#97), WP-8 (#98) alle gemergt.
Anschluss-Arbeit läuft in `2026-07-19-backlog-roadmap.md` (WP-9…19) bzw. für DE-Daten
in `2026-07-22-supabase-full-migration-de.md` → `2026-07-22-de-crawler-photos-cards-plan.md`.

Zerlegt die beschlossene Arbeit in nummerierte Arbeitspakete (**WP**), jedes in *einer*
Session ausführbar, ohne den Kontext zu sprengen. Jedes WP nennt sein Design-Doc (Detailtiefe
dort), Scope, Abhängigkeiten, Akzeptanzkriterien. **Konvention:** jedes WP startet in einem
eigenen Worktree (`EnterWorktree`), endet mit grünem Typecheck/Test und einem Review-Diff.

**Ausgangslage:** dongarra Phase 1–6 (Auth, Suchen, Watchlist, Alerts, Historie, Anwälte,
Daten-API, Kostenrechner) ist umgesetzt. Basis für alles Weitere ist eine **saubere,
neutrale Terminologie** (Nutzer-Priorität: Grundlage vor Feature-Ausbau).

## Abhängigkeits-Graph

```
WP-1 (Rename) ──┬── WP-2 (Wert-Modell) ── WP-7 (Nutzerwährung)
                ├── WP-3 (Archiv S1) ── WP-4 (Archiv PDF/DOCX) ── WP-5 (Archiv HTML)
                ├── WP-6 (UI i18n) ─────── WP-8 (Content-Übersetzung)
                └── (WP-6) ────────────────┘
```
`WP-1` ist der Flaschenhals — blockiert alles. Danach laufen die drei Stränge (Wert/Währung,
Archiv, i18n) unabhängig.

---

## WP-1 — Terminologie Phase A: reiner Rename  ⟵ ZUERST
**Doc:** `2026-07-18-terminology-harmonization-design.md` (Phase A)
**Ziel:** DE/ZVG-Feldnamen → neutrales Englisch, **kein Verhaltens-Change**.
**Scope:** Rename aller Bezeichner laut Mapping-Tabelle (Auction-Felder, AttachmentKind,
`objektart`→`propertyType` inkl. Datei, Query-Params `court`→`authority`/`kat`→`category`/
`aufgehoben`→`cancelled`); `verkehrswertEur`→`marketValueEur` als **reiner** Rename
(EUR-Semantik bleibt). DB: `ALTER TABLE … RENAME COLUMN` (idempotent) für
`auction_observations`, `watchlist_items`, `lawyer_inquiries`; **`saved_searches.filters`
jsonb-Key-Migration**.
**Vorgehen:** typgetrieben — Feld im Typ umbenennen, `tsc` listet alle Stellen, Feld für Feld
fixen. Kein blindes sed (Kommentare/UI-Strings/Upstream-Feldnamen nicht anfassen).
**Abhängigkeit:** keine.
**Akzeptanz:** `nuxi prepare && tsc --noEmit` + `pnpm test` grün; kein altes Feld mehr im Code
(grep); UI unverändert; eine vor der Migration angelegte `saved_search` funktioniert nach der
jsonb-Migration weiter.
**Session-Hinweis:** mechanisch aber breit (134 Dateien, 75 Crawler). Wenn der Kontext knapp
wird: erst Kern (types/lib/utils/api/pages/components + DB), dann in einer Folge-Session die
Crawler (der Compiler listet die verbliebenen Fehler exakt).

## WP-2 — Terminologie Phase B: Wert-Modell `marketValue`+`currency`
**Doc:** `2026-07-18-terminology-harmonization-design.md` (Phase B)
**Ziel:** Originalwert + Originalwährung als Wahrheit, `marketValueEur` abgeleitet.
**Scope:** Felder `marketValue`+`currency` am Auction-Typ; Nicht-EUR-Crawler (UK/US/CZ/PL/HU/
DK/IS/RO/…) emittieren nativ statt zu konvertieren; zentrale EUR-Ableitung über
`server/utils/exchange-rate.ts`; Migration `market_value_eur`-Historie (`currency='EUR'`).
**Abhängigkeit:** WP-1.
**Akzeptanz:** Nicht-EUR-Objekt zeigt Original+Währung *und* korrekten abgeleiteten EUR-Wert;
`priceMin/Max` filtert länderübergreifend über `marketValueEur`; EUR-Objekt:
`marketValue===marketValueEur`, `currency='EUR'`. Vitest für die EUR-Ableitung.

## WP-3 — G1 Roh-Archiv Schicht 1 + Infra + S3 + Backup
**Doc:** `2026-07-18-raw-archive-g1-design.md` (Phase 1)
**Ziel:** vollständiger geparster Stand pro Auktion unveränderlich archiviert, Primary+Backup.
**Scope:** Schema `raw_blobs`/`raw_captures`; `raw-archive.ts` (`archiveBlob`/`recordCapture`/
`archiveAuction`, per-Auktion `(platform, externalId)`, Content-Hash-Dedup, Change-only);
`s3-uploader.ts` (Outbox→Primary); Hooks in `refresh.ts` **und** `enrich.ts`; Outbox-Volume;
S3-Config; `rclone`-Backup-Sidecar (`copy`, nie `sync`; Object-Lock am Backup); `.env`.
**Abhängigkeit:** WP-1 (neue Feldnamen).
**Akzeptanz:** Lauf → pro Auktion ein Blob in Primary (uploaded_at gesetzt); zweiter Lauf ohne
Änderung → kein neuer Blob/keine Capture (Dedup + `fetchedAt`-Footgun via Per-Auktions-Hash
umgangen); `rclone copy` idempotent; DB/S3 gestoppt → Crawl läuft weiter, kein Verlust.

## WP-4 — G1 Schicht 2: Roh-Dokumente (PDF/DOCX)
**Doc:** `2026-07-18-raw-archive-g1-design.md` (Phase 2)
**Ziel:** Roh-Gutachten (PDF) + DOCX archiviert = LLM-Input für Re-Processing ohne Re-Crawl.
**Scope:** Hooks in `fetchPdfBuffer()` (`pdf-text.ts`) + `docx-text.ts`; `kind='document'`,
keyed auf `source_url`.
**Abhängigkeit:** WP-3 (`raw-archive.ts`-Helfer).
**Akzeptanz:** Objekt mit Gutachten → PDF-Blob (roh, nicht gzippt) + `document`-Capture;
zweites Objekt mit demselben PDF → kein zweiter Blob (Hash-Dedup), zweite Capture.

## WP-5 — G1 Schicht 2b: Roh-Detail-HTML
**Doc:** `2026-07-18-raw-archive-g1-design.md` (Phase 3)
**Ziel:** HTML-only-Infos (in einigen Ländern) archivieren.
**Scope:** `fetch-archive.ts` (`fetchTextAndArchive`, keyed `(platform, externalId)`);
**erst Audit**, welche Crawler relevante Infos nur im Detail-HTML haben; dann inkrementelle
Migration dieser Detail-Fetcher (HTML-only-Länder zuerst).
**Abhängigkeit:** WP-3.
**Akzeptanz:** migriertes HTML-only-Land → `detail_html`-Blob (gzippt); nicht-migriertes Land
→ kein Blob + Log (kein Silent Gap).
**Session-Hinweis:** die Crawler-Migration kann über mehrere Sessions laufen (pro
Länder-Gruppe); Audit + Wrapper + erste 1–2 Länder = eine Session.

## WP-6 — i18n Baustein A: UI-Oberfläche (DE + EN)
**Doc:** `2026-07-18-i18n-localization-design.md` (Baustein A / Phase 1)
**Ziel:** Chrome/Labels in Nutzersprache, DE+EN.
**Scope:** `@nuxtjs/i18n`, `de`/`en`-Locales; Label-Schicht verdrahten (Enum-/Kategorie-
Anzeigen: `propertyType`, `AttachmentKind`, Filter, `authority`-Kategorien — gemappt, nicht
übersetzt); Locale-Umschalter + Persistenz (Account/Cookie); Locale im SSR-Cache-Key.
**Abhängigkeit:** WP-1 (neutrale Namen für die Label-Schicht).
**Akzeptanz:** UI vollständig in DE und EN; Enum-Labels korrekt gemappt; Umschalten
persistiert über Reload; SSR liefert richtige Sprache.

## WP-7 — i18n Baustein C: Nutzerwährung + Live-Umrechnung
**Doc:** `2026-07-18-i18n-localization-design.md` (Baustein C / Phase 2)
**Ziel:** Anzeige/Filter in Nutzerwährung, ohne SSR-Cache-Explosion.
**Scope:** `exchange-rate.ts` erweitern (periodische Kurse, Kurs-Tabelle an Client);
**client-seitige** Konvertierung `marketValueEur → Nutzerwährung`; Währungs-Umschalter
(unabhängig von Sprache); Filter-Eingabe → EUR → Query.
**Abhängigkeit:** WP-2 (`marketValueEur`), WP-6 (Preference-Infrastruktur).
**Akzeptanz:** SEK-Nutzer sieht DE-Objekt mit €-Original + SEK-Wert; `priceMin/Max` in SEK
filtert korrekt; Seite nicht nach Währung gecacht; Kurse aktualisieren periodisch.

## WP-8 — i18n Baustein B: Content-Übersetzung (Freitext)
**Doc:** `2026-07-18-i18n-localization-design.md` (Baustein B / Phase 3)
**Ziel:** `title`/`description` on-demand in Zielsprache (DE+EN), LLM, gecacht.
**Scope:** Tabelle `content_translations(content_hash, lang, …)`; `translation.post.ts`
(Muster wie `summary.post.ts`: Cache-First/inflight/Rate-Limit); `country→primary-language`-
Passthrough-Map (Ziel==Quelle → kein Call); Frontend-Lazy-Load + „automatisch übersetzt".
**Abhängigkeit:** WP-1; WP-6 (Sprachwahl im Frontend).
**Akzeptanz:** DE-Objekt→EN übersetzt, zweiter Aufruf trifft Cache (kein zweiter LLM-Call);
Ziel DE → Passthrough; Inhaltsänderung (neuer `content_hash`) → neue Übersetzung;
Struktur/Eigennamen unübersetzt.

---

## Empfohlene Reihenfolge
1. **WP-1** (Fundament) → 2. **WP-2** → dann frei wählbar nach Priorität:
   - Datensammlung/Analyse-Substrat: **WP-3 → WP-4 → WP-5**
   - Internationalisierung: **WP-6 → WP-7**, dann **WP-8**

Später (eigene Roadmap, nicht hier geschnitten): G2 GraphQL, G4 Billing, G3-B Nutzer-zahlt-
Modell, Delta-Features F1–F8 (KI-Analyse, Karten-Layer, Statistik, hanmark).
