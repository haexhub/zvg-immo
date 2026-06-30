# Unified Auction Display — Design

Date: 2026-06-30
Status: Approved (design phase); Phase 1 implemented

## Goal

Every forced-auction listing — regardless of source country/state — should
render in one consistent card/page with the same data in the same place:

- A clearly recognizable **property type** (Haus, Eigentumswohnung, Grundstück,
  Mehrfamilienhaus, Ackerland, …).
- **Sizes**: Grundstücksfläche and Wohnfläche (kept separate), plus rooms and
  number of units where available.
- **Verkehrswert** (already present).
- **Photos shown directly** in card/page header — including photos that only
  exist embedded inside PDF documents (Gutachten/Exposé).
- All **official links and documents** linked from one overview, so the user
  can always reach the source portal.
- **Filterable** by type and by size ranges.

## Current state (what already exists)

- A single unified `Auction` type (`types/auction.ts`) with: platform, country,
  region, ids, `objekt` (free text), `adresse`, `verkehrswertEur/Text`, termin,
  `aufgehoben`, `pdfUrl`/`detailUrl` (+ upstream), typed `attachments[]`
  (`bekanntmachung|foto|exposee|gutachten|sonstiges`), `beschreibung`,
  `fotoCount`, `thumbnailUrl`.
- Crawlers: `zvg-portal` (DE national), `zvbawu` (DE Baden-Württemberg),
  `boe` (Spain), `at` (Austria Ediktsdatei), `biddit` (Belgium).
- A heuristic classifier `lib/objektart.ts` (`classifyObjekt`) with 13 category
  ids — runs client-side today.
- `pages/index.vue`: map ↔ list toggle, list renders cards with thumbnails,
  filters in a slide-over Sheet (country/region, search, court, price min/max,
  category, only-with-photos).
- Background-task + disk-cache pattern: `server/tasks/geocode.ts` +
  `server/plugins/geocode-bootstrap.ts` + `nuxt.config.ts` scheduledTasks, with
  `server/utils/verkehrswert-cache.ts` overlaid read-only in
  `server/api/auctions.get.ts` (`overlayCachedVerkehrswert`).
- `poppler-utils` already installed in the Docker runner image and already used
  by `server/api/zvg-thumb.get.ts` (`pdftoppm`). So `pdftotext` and `pdfimages`
  are already available — no new system dependency.

## Key decisions

1. **Extraction = hybrid**: deterministic rules first, LLM fallback only for
   what rules can't resolve.
2. **LLM = Claude Haiku via `haex-claude-proxy`** (uses the Claude
   subscription/OAuth, not API credits). The proxy is Anthropic-Messages-API
   compatible and supports structured output via a `final_result` output tool
   (`--json-schema`). It is **text-only** — `flattenContent` forwards only
   `text`/`tool_result` blocks, so the LLM never sees images.
3. **Detail view = dedicated route page** (shareable URL).
4. **Images embedded in PDFs are extracted by `pdfimages`, not the LLM.** PDF
   *text* (`pdftotext`) is fed to the rules+LLM extractor and dramatically
   improves type/size coverage (the real numbers live in the Gutachten).
5. All identifiers in code are **English**; German strings remain only as
   domain values/labels (category ids, UI text).

## Data model — the extracted layer

A single optional field on `Auction`, populated only by the post-crawl overlay
(never at crawl time — so no crawler construction site changes, and new crawlers
comply automatically):

```ts
extraction?: AuctionExtraction | null

interface AuctionExtraction {
  propertyType: PropertyType | null   // canonical id, reuses objektart taxonomy
  landAreaSqm:   number | null        // Grundstücksfläche
  livingAreaSqm: number | null        // Wohnfläche (separate from land)
  rooms:         number | null
  units:         number | null        // Wohneinheiten — separates EFH/MFH
  source: 'rules' | 'llm'
  confidence: 'high' | 'low'
  at: string                          // ISO timestamp
}
```

- `PropertyType` is a string-literal union added to `lib/objektart.ts` (mirrors
  the RULES ids + 'sonstiges'; 'unbekannt' is represented as null). The
  classifier becomes the authoritative server-side rules engine; the client
  keeps it as a fallback for not-yet-enriched items.
- `photos` (gallery URLs, incl. PDF-extracted) is added in Phase 3.

## Storage

A new `.cache_zvg/extraction.json`, keyed `platform:zvgId`, atomic write — a
direct copy of the `verkehrswert-cache.ts` contract (first-write-wins, no TTL,
resilient read). Extracted images go to `.cache_zvg/images/<platform>/<id>/`.
An enriched-auctions snapshot for the detail route goes to
`.cache_zvg/auctions.json`.

## Extraction pipeline

Runs in a new Nitro background task `enrich` mirroring `geocode` (scheduled +
bootstrapped on boot). **Never on the request path** — the LLM call spawns a
`claude` subprocess via the proxy (seconds of latency). `auctions.get.ts` only
overlays the cache read-only, like `overlayCachedVerkehrswert`.

Per auction (only ids missing from the cache):

1. **PDF processing** (Phase 2/3; reuse the `zvg-thumb` fetch→shell→cache
   pattern). Pick the richest attachment by kind: Gutachten → Exposé →
   Bekanntmachung.
   - `pdftotext -layout <pdf> -` → text appended to the extractor input.
   - `pdfimages -all -p <pdf> <prefix>` → embedded images. Filter out junk:
     min ~400×300px, sane aspect ratio, drop images repeated across pages
     (logos), cap per-PDF and per-auction counts. Store to the images cache.
2. **Rules pass** (`server/utils/extract/rules.ts`): objektart classifier on
   `objekt` + PDF text; regex size parsing over `objekt` + `beschreibung` +
   PDF text. If type is confident **and** at least one area is found → store
   `{source:'rules', confidence:'high'}`, skip the LLM.
3. **LLM fallback** (Phase 2): for incomplete/low-confidence items, POST proxy
   `/v1/messages`, model `claude-haiku-4-5`, body includes
   `tools: [{ name: 'final_result', input_schema: <extraction schema> }]`.
   Input = `objekt + beschreibung + PDF text + attachment labels`. Read back
   the `tool_use` block's `input`. Store `{source:'llm'}`.
4. **Cache write** (atomic). Sanity checks are **per-field plausibility bounds
   only** (reject negatives, parse artifacts, and absurd magnitudes — e.g. an
   area in the millions of m²). No cross-field rule like
   `livingArea > landArea`: that does not hold (a multi-story building
   legitimately exceeds its plot footprint, and an Eigentumswohnung's plot is
   shared/irrelevant).

### Config (`runtimeConfig`)

- proxy base URL, model id, LLM concurrency (low — 2-3, each call is a
  subprocess), enable flag.
- Proxy unreachable/disabled → rules-only, no hard failure.

## UI (Phase 4/5)

### Enriched cards (`pages/index.vue` list)

- Keep the thumbnail header (Phase 3: `photos[0]`).
- Replace the `objekt` title with a **type badge** from `propertyType`.
- Compact facts line, nulls omitted: `620 m² Grundstück · 140 m² Wohnfläche ·
  5 Zi.` + Verkehrswert.
- Subtle "auto-extrahiert" hint when `extraction.source === 'llm'`.
- Whole card links to the detail route.

### Detail page — `pages/objekt/[platform]/[id].vue`

The app crawls live (no store), so the `enrich` task also persists enriched
`Auction` objects to `.cache_zvg/auctions.json`. A new
`GET /api/auction/[platform]/[id]` reads that snapshot → SSR-renders instantly,
URL is shareable. Staleness is bounded by the task interval (~6h). Contents:
photo gallery, key-facts grid, single-marker map, "Offizielle Quellen" (every
attachment grouped by kind + upstream links), Beschreibung.

### Filters (Sheet)

- `propertyType` fed by the server field (client-classify fallback).
- **land-area** and **living-area** min/max ranges, mirroring the price-range
  UI. `applyFilters` is already shared by list + map.

## Phasing (each phase independently shippable)

1. **Data foundation** — `extraction` field + `PropertyType`; server-side rules
   extractor (classifyObjekt + size parsers); extraction cache; `enrich` task +
   bootstrap + schedule; overlay in `auctions.get.ts`; vitest + unit tests.
   *Rules-only works end-to-end.*  ← implemented
2. **PDF text + LLM type/size** — proxy client + `runtimeConfig`; `pdftotext`
   into the extractor; LLM fallback for rules-misses.
3. **PDF image extraction** — `pdfimages` + filter; `photos[]`;
   `/api/auction-image` endpoint.
4. **Enriched snapshot + detail route** — persist `auctions.json`;
   `/api/auction/[platform]/[id]`; detail page; card → detail link.
5. **UI enrichment** — type/size badges on cards; new size filters;
   `propertyType` filter from the server field.

## Risks / notes

- Cold full-enrich of ~2200 listings is slow like geocode (first-write-wins →
  later runs fast; rules-first minimizes LLM calls; PDF work is the heaviest
  per-item cost — cache aggressively).
- `pdfimages` can emit many junk images — the size/aspect/dedup filter and
  per-PDF cap are essential.
- LLM may hallucinate numbers — schema + confidence flag + per-field
  plausibility bounds (no cross-field invariants; `livingArea > landArea` is
  valid for multi-story buildings and meaningless for Eigentumswohnungen).
- Proxy is OAuth/subprocess-based — keep LLM concurrency low; graceful
  degrade to rules-only when unreachable.
- Detail snapshot staleness bounded by task interval; a single detail page
  could refresh live later if needed.
