<script setup lang="ts">
import { ALL_KATEGORIEN, classifyObjekt } from '~/lib/objektart'
import type { AuctionDetail } from '~/server/api/auction/[platform]/[id].get'
import type { Attachment } from '~/types/auction'
import { ArrowLeft, Sparkles } from 'lucide-vue-next'

const route = useRoute()
const platform = String(route.params.platform)
const id = String(route.params.id)

const { data: a, error, pending } = await useFetch<AuctionDetail | null>(
  `/api/auction/${platform}/${id}`,
  { default: () => null },
)

// Lazy German AI summary — pre-filled from cache if already generated,
// otherwise generated on button click.
const summary = ref<string | null>(null)
const summaryPending = ref(false)
const summaryError = ref<string | null>(null)

watch(a, (val) => {
  summary.value = val?.summary ?? null
  summaryError.value = null
}, { immediate: true })

// Minimal markdown → safe HTML: escape first, then apply bold/paragraph patterns.
// Covers the `**Heading** — text` structure the LLM returns.
const summaryHtml = computed(() => {
  if (!summary.value) return ''
  const escaped = summary.value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  return escaped
    .split(/\n\n+/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('')
})

async function loadSummary() {
  summaryPending.value = true
  summaryError.value = null
  try {
    const res = await $fetch<{ summary: string }>(
      `/api/auction/${encodeURIComponent(platform)}/${encodeURIComponent(id)}/summary`,
      { method: 'POST' },
    )
    summary.value = res.summary
  } catch (err: unknown) {
    const msg = (err as { statusMessage?: string; message?: string })?.statusMessage
      ?? (err as { message?: string })?.message
      ?? 'Unbekannter Fehler'
    summaryError.value = msg
  } finally {
    summaryPending.value = false
  }
}

const KAT_LABEL = new Map(ALL_KATEGORIEN.map((k) => [k.id, k.label]))
function kategorie(): { id: string; label: string } | null {
  if (!a.value) return null
  const pt = a.value.extraction?.propertyType
  if (pt) return { id: pt, label: KAT_LABEL.get(pt) ?? pt }
  const fallback = classifyObjekt(a.value.objekt)
  return fallback.id === 'unbekannt' ? null : fallback
}

function formatEur(n: number | null): string {
  if (n == null) return '–'
  return n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })
}

function formatDate(iso: string | null, fallback: string | null): string {
  if (!iso) return fallback ?? '–'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return fallback ?? iso
  return d.toLocaleString('de-DE', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function formatArea(n: number | null): string {
  if (n == null) return '–'
  return `${n.toLocaleString('de-DE', { maximumFractionDigits: 0 })} m²`
}

// Photo URLs: native foto attachments (when present) first, then extracted
// embedded photos from the Gutachten/Exposé PDF. Segments are
// encodeURIComponent'd — the API endpoint validates them against a strict
// allow-list, but the URL itself needs to be well-formed before we get there.
const photoUrls = computed<string[]>(() => {
  if (!a.value) return []
  const urls: string[] = []
  for (const att of a.value.attachments) {
    if (att.kind === 'foto') urls.push(att.proxyUrl)
  }
  const extracted = a.value.extraction?.photos ?? []
  const platform = encodeURIComponent(a.value.platform)
  const zvgId = encodeURIComponent(a.value.zvgId)
  for (const name of extracted) {
    urls.push(`/api/auction-image/${platform}/${zvgId}/${encodeURIComponent(name)}`)
  }
  return urls
})

const activePhotoIndex = ref(0)
watch(photoUrls, () => {
  activePhotoIndex.value = 0
})

const KIND_LABEL: Record<string, string> = {
  bekanntmachung: 'Bekanntmachung',
  foto: 'Fotos',
  exposee: 'Exposé',
  gutachten: 'Gutachten',
  sonstiges: 'Anhang',
}
const KIND_ORDER = ['bekanntmachung', 'gutachten', 'exposee', 'foto', 'sonstiges']

const groupedAttachments = computed<Array<{ kind: string; label: string; items: Attachment[] }>>(() => {
  if (!a.value) return []
  const byKind = new Map<string, Attachment[]>()
  for (const att of a.value.attachments) {
    const list = byKind.get(att.kind) ?? []
    list.push(att)
    byKind.set(att.kind, list)
  }
  return KIND_ORDER
    .filter((k) => byKind.has(k))
    .map((k) => ({ kind: k, label: KIND_LABEL[k] ?? k, items: byKind.get(k)! }))
})

useHead(() => ({
  title: a.value?.objekt
    ? `${a.value.objekt} · ${a.value.amtsgericht}`
    : 'Zwangsversteigerung',
}))
</script>

<template>
  <main class="h-full overflow-y-auto px-4 py-6">
    <div class="max-w-5xl mx-auto">
    <NuxtLink to="/" class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
      <ArrowLeft class="h-4 w-4" /> Zurück zur Übersicht
    </NuxtLink>

    <p v-if="pending" class="py-12 text-center text-muted-foreground">Lade …</p>
    <p v-else-if="error || !a" class="py-12 text-center text-destructive">
      {{ error?.statusMessage || error?.message || 'Auktion nicht gefunden.' }}
    </p>

    <template v-else>
      <header class="mb-6 space-y-2">
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <span
            v-if="kategorie()"
            class="rounded-md bg-primary/10 text-primary px-2 py-0.5 font-semibold"
          >{{ kategorie()?.label }}</span>
          <span class="rounded-md bg-secondary text-secondary-foreground px-2 py-0.5 font-medium">{{ a.amtsgericht }}</span>
          <span v-if="a.region" class="rounded-md bg-muted text-muted-foreground px-2 py-0.5">{{ a.region }}</span>
          <span v-if="a.aufgehoben" class="rounded-md bg-destructive/15 text-destructive px-2 py-0.5 font-medium">Aufgehoben</span>
          <span class="font-mono text-muted-foreground">{{ a.aktenzeichen }}</span>
        </div>
        <h1 class="text-2xl font-bold leading-tight">{{ a.objekt || 'Zwangsversteigerung' }}</h1>
        <p v-if="a.adresse" class="text-muted-foreground">{{ a.adresse }}</p>
      </header>

      <section v-if="photoUrls.length" class="mb-8 space-y-3">
        <div class="overflow-hidden rounded-xl border bg-muted">
          <img
            :src="photoUrls[activePhotoIndex]"
            :alt="`Foto ${activePhotoIndex + 1} von ${photoUrls.length} — ${a.objekt || 'Immobilie'}`"
            referrerpolicy="no-referrer"
            class="block w-full max-h-[60vh] object-contain bg-black/5"
          >
        </div>
        <div v-if="photoUrls.length > 1" class="flex gap-2 overflow-x-auto pb-1">
          <button
            v-for="(url, i) in photoUrls"
            :key="url"
            type="button"
            class="relative shrink-0 overflow-hidden rounded-md border transition-all"
            :class="i === activePhotoIndex ? 'ring-2 ring-primary border-primary' : 'opacity-70 hover:opacity-100'"
            :aria-label="`Foto ${i + 1} anzeigen`"
            @click="activePhotoIndex = i"
          >
            <img
              :src="url"
              :alt="`Foto ${i + 1}`"
              referrerpolicy="no-referrer"
              class="block h-16 w-24 object-cover"
            >
          </button>
        </div>
      </section>

      <section class="mb-8">
        <dl class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-4 rounded-xl border bg-card p-5">
          <div>
            <dt class="text-xs uppercase tracking-wide text-muted-foreground">Verkehrswert</dt>
            <dd class="text-lg font-semibold tabular-nums">{{ formatEur(a.verkehrswertEur) }}</dd>
          </div>
          <div>
            <dt class="text-xs uppercase tracking-wide text-muted-foreground">Termin</dt>
            <dd class="text-sm font-medium">{{ formatDate(a.terminIso, a.terminText) }}</dd>
          </div>
          <div v-if="a.extraction?.landAreaSqm != null">
            <dt class="text-xs uppercase tracking-wide text-muted-foreground">Grundstücksfläche</dt>
            <dd class="text-sm font-medium tabular-nums">{{ formatArea(a.extraction.landAreaSqm) }}</dd>
          </div>
          <div v-if="a.extraction?.livingAreaSqm != null">
            <dt class="text-xs uppercase tracking-wide text-muted-foreground">Wohnfläche</dt>
            <dd class="text-sm font-medium tabular-nums">{{ formatArea(a.extraction.livingAreaSqm) }}</dd>
          </div>
          <div v-if="a.extraction?.rooms != null">
            <dt class="text-xs uppercase tracking-wide text-muted-foreground">Zimmer</dt>
            <dd class="text-sm font-medium">{{ a.extraction.rooms }}</dd>
          </div>
          <div v-if="a.extraction?.units != null && a.extraction.units > 1">
            <dt class="text-xs uppercase tracking-wide text-muted-foreground">Wohneinheiten</dt>
            <dd class="text-sm font-medium">{{ a.extraction.units }}</dd>
          </div>
          <div>
            <dt class="text-xs uppercase tracking-wide text-muted-foreground">Gericht</dt>
            <dd class="text-sm font-medium">{{ a.amtsgericht }}</dd>
          </div>
          <div>
            <dt class="text-xs uppercase tracking-wide text-muted-foreground">Aktenzeichen</dt>
            <dd class="text-sm font-mono">{{ a.aktenzeichen }}</dd>
          </div>
        </dl>
        <p
          v-if="a.extraction?.source === 'llm'"
          class="mt-2 text-xs text-muted-foreground"
        >
          Eckdaten automatisch aus dem Gutachten/Exposé extrahiert
          ({{ a.extraction.confidence === 'high' ? 'hohe Konfidenz' : 'geringe Konfidenz' }}).
        </p>
      </section>

      <section class="mb-8 space-y-3">
        <div class="flex items-center gap-2">
          <h2 class="text-base font-semibold">KI-Zusammenfassung</h2>
          <span class="text-xs text-muted-foreground">(Deutsch, automatisch übersetzt)</span>
        </div>
        <div
          v-if="summary"
          class="rounded-xl border bg-card p-5 text-sm leading-relaxed [&_p]:mb-3 [&_p:last-child]:mb-0 [&_strong]:font-semibold [&_strong]:text-foreground"
          v-html="summaryHtml"
        />
        <p v-else-if="summaryError" class="text-sm text-destructive">
          Zusammenfassung konnte nicht erstellt werden: {{ summaryError }}
        </p>
        <p v-else-if="summaryPending" class="text-sm text-muted-foreground animate-pulse">
          Zusammenfassung wird erstellt … (ca. 10–30 Sekunden)
        </p>
        <button
          v-else
          type="button"
          class="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm hover:border-primary hover:text-primary transition-colors disabled:opacity-50"
          :disabled="summaryPending"
          @click="loadSummary"
        >
          <Sparkles class="h-4 w-4" />
          Zusammenfassung auf Deutsch erstellen
        </button>
      </section>

      <section v-if="a.lat != null && a.lng != null" class="mb-8 space-y-2">
        <h2 class="text-base font-semibold">Lage</h2>
        <AuctionDetailMap :lat="a.lat" :lng="a.lng" :label="a.adresse ?? undefined" :country="a.country" />
      </section>

      <section
        v-if="groupedAttachments.length > 0 || a.detailUrlUpstream || a.pdfUrlUpstream"
        class="mb-8 space-y-2"
      >
        <h2 class="text-base font-semibold">Offizielle Quellen</h2>
        <ul class="space-y-2">
          <li v-for="group in groupedAttachments" :key="group.kind" class="text-sm">
            <span class="text-xs uppercase tracking-wide text-muted-foreground">{{ group.label }}</span>
            <div class="flex flex-wrap gap-2 mt-1">
              <a
                v-for="att in group.items"
                :key="att.fileId"
                :href="att.proxyUrl"
                target="_blank"
                rel="noopener"
                class="rounded-md border bg-card px-3 py-1.5 hover:border-primary hover:text-primary transition-colors"
              >
                {{ att.label || att.filename || group.label }}
              </a>
            </div>
          </li>
          <li v-if="a.detailUrlUpstream || a.pdfUrlUpstream" class="text-sm">
            <span class="text-xs uppercase tracking-wide text-muted-foreground">Quelle</span>
            <div class="flex flex-wrap gap-2 mt-1">
              <a
                v-if="a.detailUrlUpstream"
                :href="a.detailUrlUpstream"
                target="_blank"
                rel="noopener"
                class="rounded-md border bg-card px-3 py-1.5 hover:border-primary hover:text-primary transition-colors"
              >Detailseite öffnen ↗</a>
              <a
                v-if="a.pdfUrlUpstream"
                :href="a.pdfUrlUpstream"
                target="_blank"
                rel="noopener"
                class="rounded-md border bg-card px-3 py-1.5 hover:border-primary hover:text-primary transition-colors"
              >Bekanntmachung (Original) ↗</a>
            </div>
          </li>
        </ul>
      </section>

      <section v-if="a.beschreibung" class="mb-8 space-y-2">
        <h2 class="text-base font-semibold">Beschreibung</h2>
        <p class="whitespace-pre-line text-sm text-foreground/90 leading-relaxed">
          {{ a.beschreibung }}
        </p>
      </section>
    </template>
    </div>
  </main>
</template>
