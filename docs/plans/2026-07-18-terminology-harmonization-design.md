# Terminologie-Harmonisierung (DE → neutral EN) — Design

**Status (2026-07-23): umgesetzt.** Phase A (reiner Rename) via PR #89, Phase B
(Wert-Modell `marketValue`+`currency`) via PR #91 — beide gemergt.

## Context

Das Projekt begann DE-only; das Domänen-Vokabular ist entsprechend deutsch/ZVG-zentriert
(`zvgId`, `aktenzeichen`, `amtsgericht`, `verkehrswert…`, `termin…`, `aufgehoben`, `objekt`,
`beschreibung`, AttachmentKind `bekanntmachung`/`gutachten`/`exposee`). Bei einem Produkt
über 20+ Länder ist „Amtsgericht" bei einem UK-Auktionshaus oder US-County schlicht falsch.
**Blast-Radius (gemessen): 134 Code-Dateien, davon 75 Crawler.** Dieses Doc definiert das
Mapping und das risikoarme Vorgehen; **kein Code hier — Umsetzung im eigenen Worktree**
(`EnterWorktree`), standalone und zuerst (Nutzer-Entscheidung), offene Branches rebasen darauf.

### Getroffene Entscheidungen (Nutzer)
- `amtsgericht` → **`authority`** (neutraler Oberbegriff: Gericht/Gerichtsvollzieher/Behörde/
  Auktionshaus).
- Wert: **`marketValue` + `currency`** (Originalwert + Originalwährung), Konvertierung erst
  bei Anzeige — *nicht* nur ein umbenanntes EUR-Feld.
- **Jetzt, standalone zuerst**; offene Worktrees darauf rebasen.

### Zwei Abgrenzungen
1. **Code = Englisch, UI-Text = bleibt lokalisiert.** Ein deutscher Nutzer sieht weiterhin
   „Amtsgericht"/„Verkehrswert". Umbenannt werden **Bezeichner** (Feld-/Spalten-/
   Variablennamen), nicht angezeigte Strings. Dazwischen eine dünne Label-Schicht (neutraler
   Code-Name → lokalisiertes Label). Volle UI-i18n pro Land = verwandtes, aber **separates**
   Thema, nicht Teil dieses Refactors.
2. **Quell-spezifische Namen bleiben:** `zvg-portal` (Crawler), `/api/zvg-proxy`,
   `/api/zvg-thumb`, `.cache_zvg` sind an die deutsche Quelle gebunden und korrekt. Nur die
   **generischen** Felder am länderübergreifenden `Auction`-Typ werden neutralisiert.

## Mapping

### `types/auction.ts` — Auction
| Aktuell | Neu | Anm. |
|---|---|---|
| `zvgId` | `externalId` | ID in der Quelle (`platform` = welche Quelle) |
| `aktenzeichen` | `caseNumber` | |
| `amtsgericht` | `authority` | |
| `objekt` | `title` | |
| `adresse` | `address` | |
| `verkehrswertEur` | `marketValueEur` | Phase A: reiner Rename (EUR-Semantik bleibt). Phase B: wird abgeleitetes Feld |
| `verkehrswertText` | `marketValueText` | |
| `terminIso` / `terminText` | `auctionDateIso` / `auctionDateText` | |
| `aufgehoben` | `cancelled` | |
| `letzteAktualisierungIso` | `sourceUpdatedIso` | |
| `beschreibung` | `description` | |
| `fotoCount` | `photoCount` | |
| *(schon EN, bleiben)* | `platform`,`country`,`region`,`pdfUrl*`,`detailUrl*`,`attachments`,`thumbnailUrl`,`sourceLivingAreaSqm`,`sourceLandAreaSqm`,`sourceRooms`,`photoUrls`,`lat`,`lng`,`detailFetchedAt`,`extraction` | |

### Wert-Modell (Phase B, aus der `marketValue`+`currency`-Entscheidung)
Neu am Auction-Typ:
- `marketValue: number | null` — **Originalwert in Originalwährung** (Source of Truth)
- `currency: string | null` — ISO-4217 (`EUR`,`GBP`,`USD`,`CZK`,`PLN`,`HUF`,`DKK`,`ISK`,`RON`,…)
- `marketValueEur: number | null` — **abgeleitet**, normalisiert für länderübergreifendes
  Sortieren/Filtern (die UI hat `priceMin`/`priceMax` — man kann gemischte Währungen nicht
  vergleichen, daher bleibt ein normalisiertes EUR-Feld nötig).
- `marketValueText` — Freitext wie gehabt.

### AttachmentKind (`types/auction.ts`)
`bekanntmachung`→`announcement`, `gutachten`→`appraisal`, `exposee`→`brochure`,
`foto`→`photo`, `sonstiges`→`other`. `label`/`filename`/`sizeBytes`/`fileId`/`proxyUrl` bleiben.

### `lib/objektart.ts`
Datei → `lib/property-type.ts`; `objektart`→`propertyType` (der Typ `PropertyType` ist schon EN).
`AuctionExtraction` ist bereits vollständig englisch — keine Änderung außer ggf. Importpfad.

### Query-Params / `saved_searches.filters`
`court`→`authority`, `kat`→`category`, `aufgehoben`→`cancelled`. (`country`,`region`,`q`,
`priceMin/Max`,`landMin/Max`,`livMin/Max`,`photos` sind schon EN.)
**Footgun:** `saved_searches.filters` (jsonb) spiegelt exakt diese Param-Namen und enthält in
Prod bereits Nutzerdaten mit alten Keys → **Daten-Migration nötig** (Keys in bestehenden
jsonb-Werten umschreiben), sonst brechen gespeicherte Suchen still. Je früher, desto weniger
Datensätze.

### DB-Spalten (Migration)
| Tabelle | alt → neu |
|---|---|
| `auction_observations` | `zvg_id`→`external_id`, `amtsgericht`→`authority`, `aktenzeichen`→`case_number`, `verkehrswert_eur`→`market_value_eur`, `termin_iso`→`auction_date_iso`, `aufgehoben`→`cancelled`, `objekt`→`title` |
| `watchlist_items` | `zvg_id`→`external_id`, `amtsgericht`→`authority`, `aktenzeichen`→`case_number` |
| `lawyer_inquiries` | `zvg_id`→`external_id` |
| `raw_captures` (G1, noch nicht gebaut) | `zvg_id`→`external_id`, `aktenzeichen`→`case_number`, `amtsgericht`→`authority` — beim G1-Bau gleich neu benennen |

`schema.sql` nutzt `CREATE TABLE IF NOT EXISTS` → für bestehende Prod-Tabellen echte
`ALTER TABLE … RENAME COLUMN`-Migrationen (idempotent via `IF EXISTS`-Guard bzw.
`information_schema`-Check), nicht nur das CREATE anpassen.

## Vorgehen — zwei Sub-Phasen (bewusst getrennt)

Der Rename ist „breit aber flach" und risikoarm; die Währungs-Semantik ist ein
Verhaltens-Change und berührt **jeden Nicht-EUR-Crawler**. Deshalb getrennt:

**Phase A — reiner Rename (mechanisch, kein Verhaltens-Change).**
- Typ-Feld zuerst umbenennen → `tsc` zeigt jede Fundstelle (compiler-getrieben, Feld für
  Feld). Kein blindes sed (würde Kommentare/UI-Strings treffen).
- In den 75 Crawlern ändert sich **nur die Auction-Seite** der Zuweisung; die Upstream-
  Feldnamen (`data.aktenzeichen` einer deutschen Quelle) bleiben.
- `verkehrswertEur`→`marketValueEur` als **reiner** Rename (EUR-Semantik unverändert).
- DB: `ALTER … RENAME COLUMN` + `saved_searches.filters`-Key-Migration.
- Ende Phase A: alles grün, identisches Verhalten, nur englische Namen.

**Phase B — Wert-Modell `marketValue`+`currency`+abgeleitetes `marketValueEur`.**
- Crawler emittieren künftig **nativen Wert + Währung** statt bei sich zu konvertieren; die
  Konvertierung nach EUR wandert in eine zentrale Ableitung (bestehende
  `server/utils/exchange-rate.ts` wiederverwenden).
- Betrifft alle Nicht-Eurozone-Crawler (UK/US/CZ/PL/HU/DK/IS/RO/…): heute konvertieren sie
  (oder liefern EUR) — künftig `marketValue`+`currency` roh, `marketValueEur` abgeleitet.
- EUR-Crawler: `currency='EUR'`, `marketValue===marketValueEur`.
- Migration bestehender `market_value_eur`-Historie: `currency='EUR'` annehmen (der Wert
  *war* schon EUR) — verlustfrei genug, dokumentiert.

## Koordination mit offenen Worktrees

**dongarra (Phase 1–6) ist bereits umgesetzt/gemerged** — der Rename operiert also auf `main`,
nicht gegen viele offene Feature-Branches. Damit ist die frühere Rebase-Sorge weitgehend
entschärft.
- Verbliebene offene Crawler-Branches (falls vorhanden): entweder **zuerst mergen** oder
  hinterher über den mechanischen Rename rebasen (Konflikte eindeutig auflösbar).
- G1 (noch nicht gebaut) und noch offene Delta-Features übernehmen die neue Terminologie
  direkt; die bereits geschriebenen Plan-Docs (G1, i18n) sind schon auf die neuen Namen
  geschrieben.

## Verifikation
- **Phase A:** `pnpm exec nuxi prepare && pnpm exec tsc -p .nuxt/tsconfig.server.json
  --noEmit` grün (der Compiler ist hier der Haupt-Prüfer — kein altes Feld übrig). `pnpm test`
  grün. Manuell: Liste + Objektseite + gespeicherte Suche laden identisch wie vorher; eine
  vor der Migration angelegte `saved_search` funktioniert nach der jsonb-Key-Migration weiter.
- **Phase B:** Ein Nicht-EUR-Objekt (z.B. UK/GBP) zeigt Originalwert+Währung *und* korrekt
  abgeleiteten EUR-Wert; `priceMin/Max`-Filter sortiert länderübergreifend korrekt über
  `marketValueEur`. Ein EUR-Objekt: `marketValue===marketValueEur`, `currency='EUR'`.
- Neue Vitest für die zentrale EUR-Ableitung (Konvertierung, Null-Fälle, unbekannte Währung).

## Explizit nicht Teil
- **UI-i18n** (Übersetzung der angezeigten Labels pro Land) — separater Plan; hier nur die
  Label-Schicht (neutraler Name → Label), die i18n später ermöglicht.
- **Quell-spezifische Namen** (`zvg-portal`, `zvg-proxy`, `.cache_zvg`) — bleiben.
- **Änderung der Crawler-Upstream-Parsing-Logik** über die Wert-Emission (Phase B) hinaus.
