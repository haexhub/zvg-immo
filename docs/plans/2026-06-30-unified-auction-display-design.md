# Unified Auction Display — Design

Date: 2026-06-30
Status: All phases implemented & pushed.
Branch: feat/unified-auction-display (off main). Work happens in a git worktree
(~/.config/superpowers/worktrees/mobile/feat-unified-auction-display), never the
user's main checkout — they edit it in parallel.

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

1. ✅ **Data foundation** (commit 1f216b6) — `extraction?` field on `Auction` +
   `PropertyType`/`PROPERTY_TYPES` in lib/objektart; rules extractor
   (`server/utils/extract/{sizes,rules}.ts`); extraction cache
   (`server/utils/extraction-cache.ts`); `enrich` task + `enrich-bootstrap`
   plugin + `30 */6` schedule; overlay in `auctions.get.ts`; vitest + 28 tests.
2a. ✅ **enrichOne** (commit 7941cf7) — optional `enrichOne(auction)` on the
   `PlatformCrawler` interface, implemented by all 5 crawlers (reuse their
   `enrichInBatches`). Enrich task fetches detail only for *uncached* auctions
   (once ever), runs rules over objekt + beschreibung. Failed fetches stay
   uncached for retry.
2b. ✅ **LLM + PDF text** (commit 7889b46) — `server/utils/extract/llm.ts`
   (proxy client; pure parse + clamp unit-tested) + `pdf-text.ts` (`pdftotext`
   fetch/cache). `runtimeConfig.extractLlm.{baseUrl,model}`. Enrich task: rules
   → LLM fallback (PDF text in prompt), rules values preferred, gaps filled from
   LLM; per-run LLM cap; failed calls uncached.
5. ✅ **UI enrichment** (commit da40bb4) — type badge + size line on cards,
   land/living range filters, `propertyType`-driven Objektart filter in
   `pages/index.vue`.
3. ✅ **PDF image extraction** (commit 315c3b3) — `pdfimages -list -p` over the
   best PDF (reuse `pdf-text.ts`'s `resolveSource` + `pickBestPdf`); filter drops
   masks, too-small (<400×300), extreme aspect, near-square smallish crests and
   page-1 covers; MD5 dedup removes logos that repeat across pages; landscape-
   first sort so the thumbnail lands on a photo, not an info sheet.
   Content-addressable filenames under `.cache_zvg/images/<platform>/<id>/`.
   `photos: string[]` on `AuctionExtraction`; overlay synthesises `thumbnailUrl`
   from `photos[0]` when the listing has no native foto attachment. New
   `GET /api/auction-image/[platform]/[id]/[name]` with strict allow-list.
4. ✅ **Enriched snapshot + detail route** (commit 315c3b3) — enrich task writes
   fully-decorated `Auction` objects to `.cache_zvg/auctions.json`;
   `GET /api/auction/[platform]/[id]` reads it and adds cache-only geocode
   lookups; `pages/objekt/[platform]/[id].vue` renders the photo gallery,
   Eckdaten grid, single-marker Leaflet map, "Offizielle Quellen" grouped by
   attachment kind + upstream links, and Beschreibung. List cards and map
   popups link here.

Phase numbering (2a, 2b, 5, 3, 4) reflects the actual shipping order — Phase 5
(UI on cards) shipped before 3/4 (PDF photos + detail page) because it only
needed the extraction data from 2b and didn't block on either.

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

## Measured learnings (Sachsen, ~105 real auctions)

- **Type classification is essentially solved by rules**: 98% from `objekt`
  alone (no detail needed). Non-DE sources (BOE, Biddit) will be lower — that's
  the LLM's job.
- **Sizes are the hard part**: ~1% from `objekt` alone, ~40% with `beschreibung`
  (hence enrichDetails/enrichOne in 2a). The remaining ~60% live only in the
  Gutachten/Exposé PDFs.
- **Regex over PDF text is too noisy** (produced `land=5 m²` etc.) — so PDF text
  goes to the *LLM*, not the regex rules. The LLM was precise: 3/3 sampled
  residual auctions gained correct sizes from their Gutachten (e.g. living=75.33,
  land=2174). This is why 2b feeds `pdftotext` output to the LLM rather than the
  rules.

## How to resume / operational notes

- **Verify approach used this session**: a temporary `server/utils/extract/_probe.test.ts`
  (deleted after each use) crawls one region live + runs the real extractor, and
  Playwright drives the dev UI for a screenshot. Re-create as needed; don't commit it.
- **LLM is off by default** (empty `extractLlm.baseUrl`). To enable, set
  `NUXT_EXTRACT_LLM_BASE_URL` to the proxy URL (and `NUXT_EXTRACT_LLM_MODEL`,
  default `claude-haiku-4-5`).
- **haex-claude-proxy** (~/Projekte/haex-claude-proxy): Anthropic-compatible.
  Start with `PROXY_RESOLVER=file PROXY_CREDENTIALS_HOME=$HOME PORT=<free> node src/server.js`
  — uses the user's `claude` OAuth login, spawns a `claude` subprocess per
  request. Structured output: send `tools:[{name:'final_result', input_schema}]`,
  read back the `tool_use` block's `input`. **Port 8080 on the user's host is
  occupied by an unrelated service** — use a free port (8091 worked).
- **Typecheck**: `pnpm exec nuxi prepare && pnpm exec tsc -p .nuxt/tsconfig.server.json --noEmit`
  (vue-tsc isn't installed, so .vue files aren't type-checked).
- **Commits**: English, no Claude attribution, explicit `git add <paths>` (the
  user edits the repo in parallel). Push as the `haexhub` gh account
  (`gh auth switch --user haexhub`), not `haex-space`.
