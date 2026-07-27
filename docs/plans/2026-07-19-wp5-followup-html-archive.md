# WP-5 Follow-up — restliche Detail-HTML-Crawler

**Status (2026-07-23): erledigt.** PR #100 (Audit + Wrapper + BOE/CA) und PR
#101 (dieser Follow-up: restliche 10 Länder) beide gemergt — siehe
`2026-07-18-raw-archive-g1-design.md`.

## Context

WP-5 (`docs/plans/2026-07-18-raw-archive-g1-design.md`, Phase 3) hat den Audit
+ den generischen Wrapper (`server/utils/fetch-archive.ts`) + die zwei
eindeutigsten Fälle (BOE, CA) geliefert — **PR #100**
(https://github.com/haexhub/zvg-immo/pull/100), gemergt. Dieses Dokument
schneidet den Rest des Audits in eine (oder mehrere) Folge-Sessions.

## Audit-Ergebnis (aus WP-5, vollständig)

**Gruppe A — enrichOne existiert bereits, drop-in via `fetch-archive.ts`**
(gleiches Muster wie BOE/CA in PR #100: eigenen Fetch behalten, `bytes` an
`archiveDetailCapture` geben; oder falls kein Sonderfall-Fetch nötig ist,
direkt `fetchTextAndArchive` einsetzen):

| Land | Datei | Hook-Punkt | Anmerkung |
|---|---|---|---|
| GB | `server/crawlers/gb/detail.ts:154` | `fetchDetail` (in `enrichInBatches`) | Legal-Pack-PDF bewusst nie verlinkt (Login-Wall) — HTML ist einzige Quelle |
| HU | `server/crawlers/hu/detail.ts:83` | `enrichOne`-Fetch | PDF-URLs sessiongebunden, bewusst nicht gesammelt; ISO-8859-2-Decoding beibehalten |
| LT | `server/crawlers/lt/detail.ts:72` | `enrichOne`-Fetch | bestätigt Memory-Notiz: Liste ohne Adresse/Termin |
| LV | `server/crawlers/lv/detail.ts:80` | `enrichOne`-Fetch | Wertgutachten-PDF nur *manchmal* vorhanden und deckt Kataster/Koordinaten ohnehin nicht ab — HTML immer archivieren, unabhängig vom PDF |
| PL | `server/crawlers/pl/detail.ts:71` | `enrichOne`-Fetch | nie PDF/DOCX |
| zvbawü | `server/crawlers/zvbawu/detail.ts:68,177` | `fetchDetail`/`enrichInBatches` | **Achtung:** die "HTML"-Antwort ist eine Inertia.js-SSR-Hülle — die Sachfakten stecken in einem `data-page`-JSON-Attribut (`extractInertiaPage`), nicht in Fließtext. Archivieren trotzdem sinnvoll (roher Response-Body bewahrt die Fakten), aber im Code-Kommentar transparent machen, dass es kein prosaisches HTML ist |
| zvg-portal | `server/crawlers/zvg-portal/detail.ts:14,86` | `fetchDetailPage`/`enrichInBatches` | größte Reichweite (DE, von vielen Bundesländern geteilt); Gutachten-PDF nicht auf jeder Auktion vorhanden → HTML unconditional archivieren, nicht nur wenn kein Gutachten da ist |

**Gruppe B — Detail-Fetch liegt in `list.ts`, nicht in `enrichOne`** (anderer
Integrationspunkt: `archiveDetailCapture` muss direkt im jeweiligen
`fetchDetail`/`parseDetailPage`-Helfer in `list.ts` aufgerufen werden, an der
Stelle, wo Rohtext vorliegt und die Auktions-Identität — platform/country/
externalId — bereits im Scope ist):

| Land | Datei | Hook-Punkt | Anmerkung |
|---|---|---|---|
| FR (licitor) | `server/crawlers/fr/list.ts:143-216` | `fetchDetail`/`parseDetailPage` | nie PDF/DOCX — inhaltlich lohnend trotz robots.txt-Hinweis in Memory (betrifft nur den robots-Check, nicht das Archivieren selbst) |
| FR-avoventes | `server/crawlers/fr-avoventes/list.ts:173-223` | `fetchDetail`/`parseDetailPage` | nie PDF/DOCX |
| GR | `server/crawlers/gr/list.ts:11-172` | per-URL-Fetch aus `sitemap.xml` | nie PDF/DOCX; Fakten stecken in JSON-LD innerhalb der HTML — trotzdem raw archivieren, nicht nur das JSON-LD |

**Bewusst nicht in diesem Follow-up** (aus dem WP-5-Audit, niedrigere
Priorität): DK und EE fetchen Detail-HTML ebenfalls in `list.ts`, produzieren
aber schon ein äquivalentes PDF-Attachment aus demselben Content — die
HTML-Archivierung wäre dort mutmaßlich redundant. Optionaler Stretch-Punkt,
kein Kernziel.

## Scope

1. **Gruppe A migrieren** (GB, HU, LT, LV, PL, zvbawü, zvg-portal) — pro
   Crawler: eigenen Fetch behalten (Encoding/Session-Eigenheiten!), Bytes vor
   dem Parsen an `archiveDetailCapture(bytes, identity, sourceUrl, capturedAt)`
   geben. `identity` kommt aus dem `Auction`-Objekt (platform, country,
   externalId, caseNumber, authority) — exakt wie in `boe/detail.ts`/`ca/index.ts`
   (PR #100) vorgemacht.
2. **Gruppe B migrieren** (FR, FR-avoventes, GR) — `archiveDetailCapture`
   direkt in `list.ts`s Detail-Fetch-Helfer, `capturedAt` per
   `new Date().toISOString()` am Fetch-Punkt (kein `enrichOne`, das die
   Auktion schon fertig hat — hier läuft der Fetch während des Crawls selbst).
3. Kein neuer Code in `fetch-archive.ts` nötig — der Wrapper aus PR #100 ist
   bereits generisch genug (`contentType` optional, Default `'text/html'`).
   Falls ein Crawler doch Besonderheiten braucht (z. B. zvbawü's
   Inertia-Hülle), das im Code-Kommentar am Call-Standort dokumentieren, nicht
   den Wrapper aufblähen.

## Vorgehen

Empfehlung: Gruppe A und B können in getrennten Sessions laufen (Gruppe A ist
rein mechanisch — sieben Wiederholungen desselben Musters aus PR #100;
Gruppe B braucht einen neuen Integrationspunkt in `list.ts` und daher mehr
Sorgfalt). Bei Kontext-Engpass: Gruppe A in 2 Batches (z. B.
GB+HU+LT+LV / PL+zvbawü+zvg-portal), Gruppe B danach separat.

## Akzeptanz (pro migriertem Crawler)

- Für ein Objekt aus dem migrierten Land → `detail_html`-Blob (gzipped,
  keyed auf `(platform, externalId)`); entpackt = das rohe Detail-HTML (oder
  bei zvbawü: der rohe Inertia-Response-Body).
- Zweiter Lauf ohne Quelländerung → kein neuer Blob/keine neue Capture
  (Hash-Dedup + Change-only, wie in `raw-archive.test.ts`/`fetch-archive.test.ts`
  verifiziert).
- Nicht migrierte Länder bleiben unverändert (kein Blob, kein Fehler).
- `pnpm exec nuxi prepare && pnpm exec tsc -p .nuxt/tsconfig.server.json --noEmit`
  + `pnpm test` grün.

## Merge-Policy

**Nicht autonom mergen**, unabhängig von einer evtl. im Roadmap-Doc genannten
Auto-Merge-Policy für unabhängige Archiv-Stränge — User reviewt vor dem
Merge (siehe Memory `feedback_no_autonomous_merge`).
