<script setup lang="ts">
import type { Auction, CrawlResult } from '~/types/auction'
import type { GeoAuction, GeoCrawlResult } from '~/server/api/auctions-geo.get'
import type { BundeslandEntry } from '~/server/crawlers/registry'
import { classifyObjekt } from '~/lib/objektart'
import Select from '~/components/ui/select/Select.vue'
import SelectTrigger from '~/components/ui/select/SelectTrigger.vue'
import SelectValue from '~/components/ui/select/SelectValue.vue'
import SelectContent from '~/components/ui/select/SelectContent.vue'
import SelectItem from '~/components/ui/select/SelectItem.vue'

// Bundesland selection drives both the auction fetch and the geo fetch.
// Default 'all' = aggregate over every registered platform / Bundesland.
const selectedLand = ref<string>('all')

const { data: bundeslaender } = await useFetch<BundeslandEntry[]>('/api/bundeslaender', {
  default: () => [],
})

// Lazy fetch so SSR doesn't block on a cold multi-state crawl (~30s when
// 'all' is selected with no SWR cache yet).
const { data, pending, error, refresh } = useLazyFetch<CrawlResult>('/api/auctions', {
  query: { land: selectedLand },
  default: () => null,
})

const view = ref<'list' | 'map'>('list')

// Geo-fetch is gated behind the map view, but its query reacts to selectedLand
// so a switch back to map after picking a different state refetches.
// Cache-only mode loads instantly from already-geocoded addresses.
// Switching the toggle to "frisch geokodieren" hits Nominatim for missing
// addresses — slow on cold start (1 req/s) but caches future calls.
const fetchMissing = ref(false)
const {
  data: geoData,
  pending: geoPending,
  error: geoError,
  execute: loadGeo,
  refresh: refreshGeo,
} = useFetch<GeoCrawlResult>('/api/auctions-geo', {
  query: { land: selectedLand, fetch: computed(() => (fetchMissing.value ? '1' : '0')) },
  default: () => null,
  immediate: false,
})

watch(view, (v) => {
  if (v === 'map' && !geoData.value && !geoPending.value) loadGeo()
})

const search = ref('')
const includeAufgehoben = ref(false)
const courtFilter = ref<string>('all')
const priceMin = ref<number | null>(null)
const priceMax = ref<number | null>(null)
const kategorieFilter = ref<string>('all')
const onlyWithPhotos = ref(false)

// When the user switches Bundesland, the previously-selected Amtsgericht may
// no longer exist in the new dataset. Reset it to avoid an empty list.
watch(selectedLand, () => {
  courtFilter.value = 'all'
  kategorieFilter.value = 'all'
})

const selectedLandLabel = computed(() => {
  if (selectedLand.value === 'all') return 'Deutschland'
  return bundeslaender.value?.find((b) => b.abk === selectedLand.value)?.name ?? selectedLand.value
})

const courts = computed(() => {
  if (!data.value) return []
  return [...new Set(data.value.auctions.map((a) => a.amtsgericht).filter(Boolean))].sort()
})

// Counts of normalized Objektart categories. Sorted by descending count so
// the most common categories show up first in the dropdown.
const kategorienMitCount = computed<{ id: string; label: string; count: number }[]>(() => {
  if (!data.value) return []
  const counts = new Map<string, { label: string; count: number }>()
  for (const a of data.value.auctions) {
    if (a.aufgehoben) continue
    const k = classifyObjekt(a.objekt)
    const entry = counts.get(k.id)
    if (entry) entry.count++
    else counts.set(k.id, { label: k.label, count: 1 })
  }
  return [...counts.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'de'))
})

function clearAllFilters(): void {
  search.value = ''
  courtFilter.value = 'all'
  priceMin.value = null
  priceMax.value = null
  kategorieFilter.value = 'all'
  onlyWithPhotos.value = false
  includeAufgehoben.value = false
}

function applyFilters<T extends Auction>(items: T[]): T[] {
  const q = search.value.trim().toLowerCase()
  const kat = kategorieFilter.value
  const min = priceMin.value
  const max = priceMax.value
  return items.filter((a) => {
    if (!includeAufgehoben.value && a.aufgehoben) return false
    if (courtFilter.value !== 'all' && a.amtsgericht !== courtFilter.value) return false
    if (kat !== 'all' && classifyObjekt(a.objekt).id !== kat) return false
    if (onlyWithPhotos.value && a.fotoCount === 0) return false
    if (min != null && (a.verkehrswertEur == null || a.verkehrswertEur < min)) return false
    if (max != null && (a.verkehrswertEur == null || a.verkehrswertEur > max)) return false
    if (!q) return true
    const hay = `${a.aktenzeichen} ${a.amtsgericht} ${a.objekt ?? ''} ${a.adresse ?? ''} ${a.beschreibung ?? ''}`.toLowerCase()
    return hay.includes(q)
  })
}

const filtered = computed<Auction[]>(() => {
  if (!data.value) return []
  return applyFilters(data.value.auctions)
})

const filteredGeo = computed<GeoAuction[]>(() => {
  if (!geoData.value) return []
  return applyFilters(geoData.value.auctions).filter((a) => a.lat != null && a.lng != null)
})

const totals = computed(() => {
  if (!data.value) return { gesamt: 0, aktiv: 0, aufgehoben: 0 }
  const aufgehoben = data.value.auctions.filter((a) => a.aufgehoben).length
  return {
    gesamt: data.value.auctions.length,
    aktiv: data.value.auctions.length - aufgehoben,
    aufgehoben,
  }
})

const activeFilterCount = computed(() => {
  let n = 0
  if (search.value.trim()) n++
  if (courtFilter.value !== 'all') n++
  if (priceMin.value != null) n++
  if (priceMax.value != null) n++
  if (kategorieFilter.value !== 'all') n++
  if (onlyWithPhotos.value) n++
  if (includeAufgehoben.value) n++
  return n
})

function formatEur(n: number | null): string {
  if (n == null) return '–'
  return n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })
}

function formatDate(iso: string | null, fallback: string | null): string {
  if (!iso) return fallback ?? '–'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return fallback ?? iso
  return d.toLocaleString('de-DE', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max).replace(/\s+\S*$/, '') + '…'
}

const KIND_LABEL: Record<string, string> = {
  bekanntmachung: 'Bekanntmachung',
  foto: 'Fotos',
  exposee: 'Exposé',
  gutachten: 'Gutachten',
  sonstiges: 'Anhang',
}

function attachmentLabel(att: { kind: string; label: string }): string {
  return KIND_LABEL[att.kind] ?? att.label ?? 'Anhang'
}
</script>

<template>
  <main class="container mx-auto max-w-6xl px-4 py-6 pb-16">
    <header class="mb-6">
      <h1 class="text-3xl font-bold tracking-tight">Zwangsversteigerungen {{ selectedLandLabel }}</h1>
      <p class="mt-1 text-sm text-muted-foreground">
        Live aus dem amtlichen
        <a class="text-primary underline-offset-4 hover:underline" href="https://www.zvg-portal.de" target="_blank" rel="noopener">ZVG-Portal der Länder</a>.
        Daten werden bei jedem Aufruf gecrawlt (max. 30 Min Cache).
      </p>
      <div v-if="data" class="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground">
        <span><span class="font-semibold text-foreground">{{ totals.gesamt }}</span> Termine gesamt</span>
        <span><span class="font-semibold text-emerald-600 dark:text-emerald-500">{{ totals.aktiv }}</span> aktiv</span>
        <span><span class="font-semibold">{{ totals.aufgehoben }}</span> aufgehoben</span>
        <span v-if="data">Stand: {{ new Date(data.fetchedAt).toLocaleString('de-DE') }}</span>
      </div>
    </header>

    <section class="mb-6 rounded-xl border bg-card p-4 shadow-sm space-y-4">
      <div class="flex flex-wrap items-center gap-2">
        <label class="text-sm font-medium text-muted-foreground">Bundesland:</label>
        <Select v-model="selectedLand">
          <SelectTrigger class="w-56">
            <SelectValue placeholder="Bundesland wählen" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle Bundesländer</SelectItem>
            <SelectItem v-for="b in bundeslaender" :key="b.abk" :value="b.abk">{{ b.name }}</SelectItem>
          </SelectContent>
        </Select>
        <span v-if="selectedLand === 'all' && pending" class="text-xs text-muted-foreground">
          Erstaufruf kann ~30s dauern (16 Bundesländer parallel)
        </span>
      </div>

      <div class="flex flex-wrap items-center gap-2 border-t pt-4">
        <input
          v-model="search"
          type="search"
          placeholder="Suche: Ort, Aktenzeichen, Objekt, Beschreibung …"
          class="flex-1 min-w-60 h-9 rounded-md border bg-background px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
        <Select v-model="courtFilter">
          <SelectTrigger class="w-56">
            <SelectValue placeholder="Amtsgericht wählen" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle Amtsgerichte</SelectItem>
            <SelectItem v-for="c in courts" :key="c" :value="c">{{ c }}</SelectItem>
          </SelectContent>
        </Select>
        <button
          :disabled="pending"
          class="h-9 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 disabled:opacity-50 disabled:cursor-progress"
          @click="refresh()"
        >
          {{ pending ? 'Lädt …' : 'Neu laden' }}
        </button>
      </div>

      <div class="border-t pt-4 grid gap-4 md:grid-cols-[1fr_auto] md:items-center">
        <div class="flex flex-wrap items-center gap-2">
          <label class="text-sm text-muted-foreground">Verkehrswert:</label>
          <input
            v-model.number="priceMin"
            type="number"
            min="0"
            step="10000"
            placeholder="von €"
            class="h-8 w-28 rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
          <span class="text-muted-foreground">–</span>
          <input
            v-model.number="priceMax"
            type="number"
            min="0"
            step="10000"
            placeholder="bis €"
            class="h-8 w-28 rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
          <div class="flex gap-1 ml-2">
            <button
              v-for="(p, i) in [
                { label: '≤ 100k', min: null, max: 100_000 },
                { label: '100–300k', min: 100_000, max: 300_000 },
                { label: '300–600k', min: 300_000, max: 600_000 },
                { label: '≥ 600k', min: 600_000, max: null },
              ]"
              :key="i"
              type="button"
              class="rounded-full border px-3 py-0.5 text-xs text-muted-foreground hover:border-primary hover:text-primary transition-colors"
              @click="priceMin = p.min; priceMax = p.max"
            >{{ p.label }}</button>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-4 text-sm">
          <label class="flex items-center gap-2 cursor-pointer text-muted-foreground hover:text-foreground">
            <input v-model="onlyWithPhotos" type="checkbox" class="h-4 w-4 rounded border-input accent-primary"> Nur mit Fotos
          </label>
          <label class="flex items-center gap-2 cursor-pointer text-muted-foreground hover:text-foreground">
            <input v-model="includeAufgehoben" type="checkbox" class="h-4 w-4 rounded border-input accent-primary"> Aufgehobene
          </label>
          <button
            class="rounded-full border border-destructive px-3 py-1 text-xs text-destructive hover:bg-destructive hover:text-white"
            :class="{ 'invisible pointer-events-none': activeFilterCount === 0 }"
            :tabindex="activeFilterCount === 0 ? -1 : 0"
            :aria-hidden="activeFilterCount === 0"
            @click="clearAllFilters"
          >
            Filter zurücksetzen ({{ activeFilterCount }})
          </button>
        </div>
      </div>

      <div v-if="kategorienMitCount.length" class="border-t pt-4 flex flex-wrap items-center gap-2">
        <label class="text-sm text-muted-foreground">Objektart:</label>
        <Select v-model="kategorieFilter">
          <SelectTrigger class="w-72">
            <SelectValue placeholder="Objektart wählen" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle Objektarten</SelectItem>
            <SelectItem v-for="k in kategorienMitCount" :key="k.id" :value="k.id">
              {{ k.label }} ({{ k.count }})
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </section>

    <div class="mb-4 flex items-center justify-between gap-3">
      <div v-if="filtered.length" class="text-sm text-muted-foreground">
        {{ filtered.length }} Treffer<span v-if="view === 'map' && geoData">
          · {{ filteredGeo.length }} auf Karte ({{ geoData.geocodedCount }}/{{ geoData.auctions.length }} geokodiert)
        </span>
      </div>
      <div class="ml-auto inline-flex h-9 items-center rounded-md border bg-card p-1 text-sm shadow-xs">
        <button
          class="h-7 rounded px-3 transition-colors"
          :class="view === 'list' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'"
          @click="view = 'list'"
        >Liste</button>
        <button
          class="h-7 rounded px-3 transition-colors"
          :class="view === 'map' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'"
          @click="view = 'map'"
        >Karte</button>
      </div>
    </div>

    <p v-if="pending && !data" class="py-12 text-center text-muted-foreground">Lade Daten vom ZVG-Portal …</p>
    <p v-else-if="error" class="py-12 text-center text-destructive">
      Fehler beim Laden: {{ error.statusMessage || error.message }}
    </p>
    <p v-else-if="view === 'list' && filtered.length === 0" class="py-12 text-center text-muted-foreground">
      Keine Termine entsprechen den Filtern.
    </p>

    <section v-if="view === 'map'">
      <p v-if="geoPending" class="py-12 text-center text-muted-foreground">
        Lade geokodierte Daten …
      </p>
      <p v-else-if="geoError" class="py-12 text-center text-destructive">
        Fehler beim Geokodieren: {{ geoError.statusMessage || geoError.message }}
      </p>
      <ClientOnly v-else-if="geoData">
        <div class="mb-3 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <span>{{ geoData.geocodedCount }} von {{ geoData.auctions.length }} Adressen geokodiert</span>
          <button
            class="rounded-md border px-3 py-1 text-xs hover:border-primary hover:text-primary disabled:opacity-50"
            :disabled="geoPending"
            @click="fetchMissing = true; refreshGeo()"
          >
            Fehlende geokodieren (kann mehrere Minuten dauern, OSM erlaubt 1 Anfrage/s)
          </button>
        </div>
        <AuctionMap :auctions="filteredGeo" />
        <template #fallback>
          <div class="h-[70vh] rounded-xl border bg-muted/30 flex items-center justify-center text-muted-foreground">
            Lade Karte …
          </div>
        </template>
      </ClientOnly>
    </section>

    <ul v-if="view === 'list' && filtered.length" class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      <li v-for="a in filtered" :key="a.zvgId">
        <article
          class="h-full flex flex-col rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden"
          :class="{ 'opacity-60': a.aufgehoben }"
        >
          <a
            v-if="a.thumbnailUrl"
            :href="a.attachments.find((x) => x.kind === 'foto')?.proxyUrl ?? a.detailUrl"
            target="_blank"
            rel="noopener"
            class="relative block overflow-hidden border-b group"
            :title="`${a.fotoCount} Foto${a.fotoCount === 1 ? '' : 's'} öffnen`"
          >
            <img
              :src="a.thumbnailUrl"
              loading="lazy"
              alt=""
              referrerpolicy="no-referrer"
              class="aspect-[16/10] w-full object-cover transition-transform duration-200 group-hover:scale-105"
            >
            <span
              v-if="a.fotoCount > 1"
              class="absolute bottom-2 right-2 rounded-full bg-black/70 px-2 py-0.5 text-xs text-white"
            >+{{ a.fotoCount - 1 }}</span>
          </a>
          <div v-else-if="!a.aufgehoben" class="flex aspect-[16/10] items-center justify-center bg-muted text-muted-foreground text-sm border-b">
            Kein Foto
          </div>

          <div class="p-4 flex-1 flex flex-col gap-2">
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <span class="rounded-md bg-secondary text-secondary-foreground px-2 py-0.5 font-medium">{{ a.amtsgericht }}</span>
              <span v-if="a.aufgehoben" class="rounded-md bg-destructive/15 text-destructive px-2 py-0.5 font-medium">Aufgehoben</span>
              <span class="font-mono text-muted-foreground">{{ a.aktenzeichen }}</span>
            </div>
            <h2 class="text-base font-semibold leading-tight mt-1">{{ a.objekt || 'Objektart unbekannt' }}</h2>
            <p v-if="a.adresse" class="text-sm text-muted-foreground">{{ a.adresse }}</p>
            <p v-if="a.beschreibung" class="text-sm text-muted-foreground leading-relaxed mt-1">
              {{ truncate(a.beschreibung, 220) }}
            </p>
            <dl class="grid grid-cols-2 gap-3 text-sm mt-2">
              <div>
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">Termin</dt>
                <dd class="font-medium">{{ formatDate(a.terminIso, a.terminText) }}</dd>
              </div>
              <div>
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">Verkehrswert</dt>
                <dd class="font-medium tabular-nums">{{ formatEur(a.verkehrswertEur) }}</dd>
              </div>
            </dl>
          </div>

          <footer class="border-t px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <a v-if="a.pdfUrl" :href="a.pdfUrl" target="_blank" rel="noopener" class="text-primary hover:underline">
              Bekanntmachung
            </a>
            <a
              v-for="att in a.attachments.filter((x) => x.kind !== 'bekanntmachung')"
              :key="att.fileId"
              :href="att.proxyUrl"
              target="_blank"
              rel="noopener"
              class="text-primary hover:underline"
            >{{ attachmentLabel(att) }}</a>
            <a :href="a.detailUrl" target="_blank" rel="noopener" class="ml-auto text-primary hover:underline">
              Details →
            </a>
          </footer>
        </article>
      </li>
    </ul>
  </main>
</template>
