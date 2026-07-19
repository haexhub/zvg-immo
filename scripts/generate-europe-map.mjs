// One-off generator: turns world-atlas TopoJSON into a flat list of SVG path
// strings for the Europe landing-page map, so the client ships no d3/topojson
// code at runtime. Re-run manually if EUROPE_COUNTRIES below changes.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { geoMercator, geoPath } from 'd3-geo'
import { feature } from 'topojson-client'
import countries50m from 'world-atlas/countries-50m.json' with { type: 'json' }

// ISO 3166-1 numeric -> our lowercase alpha-2 code. Covers all countries we
// support (server/crawlers/registry.ts COUNTRY_NAMES) plus the remaining
// European countries so the map has full geographic context (rendered grey).
// Russia is intentionally excluded: including it would blow up the map's
// bounding box far to the east and dwarf the rest of Europe.
const EUROPE_COUNTRIES = {
  276: 'de', 40: 'at', 724: 'es', 380: 'it', 203: 'cz', 616: 'pl', 56: 'be',
  348: 'hu', 440: 'lt', 70: 'ba', 752: 'se', 246: 'fi', 208: 'dk', 250: 'fr',
  352: 'is', 233: 'ee', 428: 'lv', 620: 'pt', 705: 'si', 300: 'gr', 826: 'gb',
  // context-only countries (not yet crawled, shown grey and non-clickable)
  578: 'no', 756: 'ch', 528: 'nl', 372: 'ie', 442: 'lu', 703: 'sk', 191: 'hr',
  688: 'rs', 642: 'ro', 100: 'bg', 804: 'ua', 112: 'by', 498: 'md', 807: 'mk',
  8: 'al', 499: 'me', 196: 'cy', 20: 'ad', 438: 'li', 470: 'mt', 492: 'mc',
  674: 'sm', 336: 'va',
}

// world-atlas ids are zero-padded ISO numeric strings (e.g. "040" for
// Austria); normalize away the padding to match the EUROPE_COUNTRIES keys.
const numericId = (f) => String(parseInt(f.id, 10))

const geo = feature(countries50m, countries50m.objects.countries)
const europeFeatures = geo.features
  .filter((f) => EUROPE_COUNTRIES[numericId(f)] !== undefined)
  .map((f) => ({ ...f, code: EUROPE_COUNTRIES[numericId(f)] }))

const WIDTH = 800
const HEIGHT = 800
const projection = geoMercator().fitSize(
  [WIDTH, HEIGHT],
  { type: 'FeatureCollection', features: europeFeatures },
)
const path = geoPath(projection)

const countries = europeFeatures
  .map((f) => ({ code: f.code, name: f.properties.name, path: path(f) }))
  .filter((c) => c.path)
  .sort((a, b) => a.code.localeCompare(b.code))

const out = { viewBox: `0 0 ${WIDTH} ${HEIGHT}`, countries }
const outPath = fileURLToPath(new URL('../assets/data/europe-map.json', import.meta.url))
writeFileSync(outPath, JSON.stringify(out))
console.log(`Wrote ${countries.length} country paths to ${outPath}`)
