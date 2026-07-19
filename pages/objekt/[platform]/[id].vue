<script setup lang="ts">
import { classifyPropertyType } from '~/lib/property-type'
import type { AuctionDetail } from '~/server/api/auction/[platform]/[id].get'
import type { Attachment } from '~/types/auction'
import { ATTACHMENT_KIND_ORDER } from '~/lib/auction-constants'
import { isPassthroughLanguage, type ContentTargetLang } from '~/lib/content-language'
import { ArrowLeft, Sparkles } from 'lucide-vue-next'

const route = useRoute()
const platform = String(route.params.platform)
const id = String(route.params.id)
const { t, locale } = useI18n()
const intlLocale = useIntlLocale()
const { currency, eurToDisplay } = useCurrencyDisplay()
const propertyTypeLabel = usePropertyTypeLabel()
const attachmentKindLabelFn = useAttachmentKindLabel()

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

// Auto-translated title/description (WP-8): loaded silently whenever the
// viewer's locale differs from the auction's source language — unlike the
// summary above, no manual button, since this replaces text the user would
// otherwise see untranslated. Falls back to the original text (via the
// computed below) while pending or on error.
const translatedTitle = ref<string | null>(null)
const translatedDescription = ref<string | null>(null)

const displayTitle = computed(() => translatedTitle.value ?? a.value?.title ?? null)
const displayDescription = computed(() => translatedDescription.value ?? a.value?.description ?? null)
const titleTranslated = computed(() => translatedTitle.value != null)
const descriptionTranslated = computed(() => translatedDescription.value != null)

const translationSeq = ref(0)
watch([a, locale], async ([val, loc]) => {
  const seq = ++translationSeq.value
  translatedTitle.value = null
  translatedDescription.value = null
  if (!val) return
  if (val.title == null && val.description == null) return
  if (isPassthroughLanguage(val.country, loc as ContentTargetLang)) return

  try {
    const res = await $fetch<{ title: string | null; description: string | null }>(
      `/api/auction/${encodeURIComponent(platform)}/${encodeURIComponent(id)}/translation`,
      { method: 'POST', query: { lang: loc } },
    )
    // A newer (a, locale) change already superseded this request; dropping the
    // result avoids a slow earlier response overwriting fresher content.
    if (seq !== translationSeq.value) return
    translatedTitle.value = res.title
    translatedDescription.value = res.description
  } catch {
    // Best-effort: keep showing the original text (see displayTitle/displayDescription).
  }
}, { immediate: true })

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
      ?? t('objektDetail.aiSummaryErrorFallback')
    summaryError.value = msg
  } finally {
    summaryPending.value = false
  }
}

function category(): { id: string; label: string } | null {
  if (!a.value) return null
  const pt = a.value.extraction?.propertyType
  if (pt) return { id: pt, label: propertyTypeLabel(pt) }
  const fallback = classifyPropertyType(a.value.title)
  return fallback.id === 'unbekannt' ? null : { id: fallback.id, label: propertyTypeLabel(fallback.id, fallback.label) }
}

function formatPrice(marketValueEur: number | null): string {
  const converted = eurToDisplay(marketValueEur)
  if (converted == null) return '–'
  return converted.toLocaleString(intlLocale.value, { style: 'currency', currency: currency.value, maximumFractionDigits: 0 })
}

// Shown whenever the auction's native currency differs from the viewer's
// display currency — including a EUR-native (e.g. German) auction viewed by
// a non-EUR user, which formatPrice() alone wouldn't make obvious.
function showOriginalPrice(): boolean {
  return !!a.value?.marketValueText && (a.value?.currency ?? 'EUR') !== currency.value
}

function formatDate(iso: string | null, fallback: string | null): string {
  if (!iso) return fallback ?? '–'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return fallback ?? iso
  return d.toLocaleString(intlLocale.value, {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function formatArea(n: number | null): string {
  if (n == null) return '–'
  return `${n.toLocaleString(intlLocale.value, { maximumFractionDigits: 0 })} m²`
}

// Photo URLs: native foto attachments (when present) first, then extracted
// embedded photos from the Gutachten/Exposé PDF. Segments are
// encodeURIComponent'd — the API endpoint validates them against a strict
// allow-list, but the URL itself needs to be well-formed before we get there.
const photoUrls = computed<string[]>(() => {
  if (!a.value) return []
  const urls: string[] = []
  for (const att of a.value.attachments) {
    if (att.kind === 'photo') urls.push(att.proxyUrl)
  }
  const extracted = a.value.extraction?.photos ?? []
  const platform = encodeURIComponent(a.value.platform)
  const externalId = encodeURIComponent(a.value.externalId)
  for (const name of extracted) {
    urls.push(`/api/auction-image/${platform}/${externalId}/${encodeURIComponent(name)}`)
  }
  return urls
})

const activePhotoIndex = ref(0)
watch(photoUrls, () => {
  activePhotoIndex.value = 0
})

const groupedAttachments = computed<Array<{ kind: string; label: string; items: Attachment[] }>>(() => {
  if (!a.value) return []
  const byKind = new Map<string, Attachment[]>()
  for (const att of a.value.attachments) {
    const list = byKind.get(att.kind) ?? []
    list.push(att)
    byKind.set(att.kind, list)
  }
  return ATTACHMENT_KIND_ORDER
    .filter((k) => byKind.has(k))
    .map((k) => ({ kind: k, label: attachmentKindLabelFn(k, k), items: byKind.get(k)! }))
})

useHead(() => ({
  title: displayTitle.value
    ? `${displayTitle.value} · ${a.value?.authority}`
    : t('objektDetail.untitled'),
}))
</script>

<template>
  <main class="h-full overflow-y-auto px-4 py-6">
    <div class="max-w-5xl mx-auto">
    <div class="flex items-center justify-between mb-4">
      <NuxtLink to="/" class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft class="h-4 w-4" /> {{ $t('objektDetail.back') }}
      </NuxtLink>
      <AuthStatus />
    </div>

    <p v-if="pending" class="py-12 text-center text-muted-foreground">{{ $t('objektDetail.loading') }}</p>
    <p v-else-if="error || !a" class="py-12 text-center text-destructive">
      {{ error?.statusMessage || error?.message || $t('objektDetail.notFound') }}
    </p>

    <template v-else>
      <header class="mb-6 space-y-2">
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <span
            v-if="category()"
            class="rounded-md bg-primary/10 text-primary px-2 py-0.5 font-semibold"
          >{{ category()?.label }}</span>
          <span class="rounded-md bg-secondary text-secondary-foreground px-2 py-0.5 font-medium">{{ a.authority }}</span>
          <span v-if="a.region" class="rounded-md bg-muted text-muted-foreground px-2 py-0.5">{{ a.region }}</span>
          <span v-if="a.cancelled" class="rounded-md bg-destructive/15 text-destructive px-2 py-0.5 font-medium">{{ $t('objektDetail.cancelled') }}</span>
          <span class="font-mono text-muted-foreground">{{ a.caseNumber }}</span>
        </div>
        <div class="flex flex-wrap items-baseline gap-2">
          <h1 class="text-2xl font-bold leading-tight">{{ displayTitle || $t('objektDetail.untitled') }}</h1>
          <span v-if="titleTranslated" class="text-xs text-muted-foreground">({{ $t('objektDetail.autoTranslatedHint') }})</span>
        </div>
        <p v-if="a.address" class="text-muted-foreground">{{ a.address }}</p>
      </header>

      <section v-if="photoUrls.length" class="mb-8 space-y-3">
        <div class="overflow-hidden rounded-xl border bg-muted">
          <img
            :src="photoUrls[activePhotoIndex]"
            :alt="$t('objektDetail.photoAlt', { n: activePhotoIndex + 1, total: photoUrls.length, title: displayTitle || $t('objektDetail.fallbackTitle') })"
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
            :aria-label="$t('objektDetail.showPhoto', { n: i + 1 })"
            @click="activePhotoIndex = i"
          >
            <img
              :src="url"
              :alt="$t('objektDetail.photoAltShort', { n: i + 1 })"
              referrerpolicy="no-referrer"
              class="block h-16 w-24 object-cover"
            >
          </button>
        </div>
      </section>

      <section class="mb-8">
        <dl class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-4 rounded-xl border bg-card p-5">
          <div>
            <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.marketValue') }}</dt>
            <dd class="text-lg font-semibold tabular-nums">{{ formatPrice(a.marketValueEur) }}</dd>
            <dd
              v-if="showOriginalPrice()"
              class="text-xs text-muted-foreground"
            >
              {{ $t('objektDetail.original', { value: a.marketValueText }) }}
            </dd>
          </div>
          <div>
            <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.auctionDate') }}</dt>
            <dd class="text-sm font-medium">{{ formatDate(a.auctionDateIso, a.auctionDateText) }}</dd>
          </div>
          <div v-if="a.extraction?.landAreaSqm != null">
            <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.landArea') }}</dt>
            <dd class="text-sm font-medium tabular-nums">{{ formatArea(a.extraction.landAreaSqm) }}</dd>
          </div>
          <div v-if="a.extraction?.livingAreaSqm != null">
            <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.livingArea') }}</dt>
            <dd class="text-sm font-medium tabular-nums">{{ formatArea(a.extraction.livingAreaSqm) }}</dd>
          </div>
          <div v-if="a.extraction?.rooms != null">
            <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.rooms') }}</dt>
            <dd class="text-sm font-medium">{{ a.extraction.rooms }}</dd>
          </div>
          <div v-if="a.extraction?.units != null && a.extraction.units > 1">
            <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.units') }}</dt>
            <dd class="text-sm font-medium">{{ a.extraction.units }}</dd>
          </div>
          <div>
            <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.authority') }}</dt>
            <dd class="text-sm font-medium">{{ a.authority }}</dd>
          </div>
          <div>
            <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.caseNumber') }}</dt>
            <dd class="text-sm font-mono">{{ a.caseNumber }}</dd>
          </div>
        </dl>
        <p
          v-if="a.extraction?.source === 'llm'"
          class="mt-2 text-xs text-muted-foreground"
        >
          {{ $t('objektDetail.extractionNotice', { confidence: a.extraction.confidence === 'high' ? $t('objektDetail.confidenceHigh') : $t('objektDetail.confidenceLow') }) }}
        </p>
      </section>

      <CostCalculator v-if="a.country === 'de'" :market-value-eur="a.marketValueEur" :region="a.region" />

      <LawyerContact :platform="a.platform" :external-id="a.externalId" :country="a.country" />

      <section class="mb-8 space-y-3">
        <div class="flex items-center gap-2">
          <h2 class="text-base font-semibold">{{ $t('objektDetail.aiSummaryTitle') }}</h2>
          <span class="text-xs text-muted-foreground">{{ $t('objektDetail.aiSummaryHint') }}</span>
        </div>
        <div
          v-if="summary"
          class="rounded-xl border bg-card p-5 text-sm leading-relaxed [&_p]:mb-3 [&_p:last-child]:mb-0 [&_strong]:font-semibold [&_strong]:text-foreground"
          v-html="summaryHtml"
        />
        <p v-else-if="summaryError" class="text-sm text-destructive">
          {{ $t('objektDetail.aiSummaryError', { msg: summaryError }) }}
        </p>
        <p v-else-if="summaryPending" class="text-sm text-muted-foreground animate-pulse">
          {{ $t('objektDetail.aiSummaryPending') }}
        </p>
        <button
          v-else
          type="button"
          class="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm hover:border-primary hover:text-primary transition-colors disabled:opacity-50"
          :disabled="summaryPending"
          @click="loadSummary"
        >
          <Sparkles class="h-4 w-4" />
          {{ $t('objektDetail.aiSummaryGenerate') }}
        </button>
      </section>

      <section v-if="a.lat != null && a.lng != null" class="mb-8 space-y-2">
        <h2 class="text-base font-semibold">{{ $t('objektDetail.location') }}</h2>
        <AuctionDetailMap :lat="a.lat" :lng="a.lng" :label="a.address ?? undefined" :country="a.country" />
      </section>

      <section
        v-if="groupedAttachments.length > 0 || a.detailUrlUpstream || a.pdfUrlUpstream"
        class="mb-8 space-y-2"
      >
        <h2 class="text-base font-semibold">{{ $t('objektDetail.officialSources') }}</h2>
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
            <span class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.source') }}</span>
            <div class="flex flex-wrap gap-2 mt-1">
              <a
                v-if="a.detailUrlUpstream"
                :href="a.detailUrlUpstream"
                target="_blank"
                rel="noopener"
                class="rounded-md border bg-card px-3 py-1.5 hover:border-primary hover:text-primary transition-colors"
              >{{ $t('objektDetail.openDetailPage') }}</a>
              <a
                v-if="a.pdfUrlUpstream"
                :href="a.pdfUrlUpstream"
                target="_blank"
                rel="noopener"
                class="rounded-md border bg-card px-3 py-1.5 hover:border-primary hover:text-primary transition-colors"
              >{{ $t('objektDetail.announcementOriginal') }}</a>
            </div>
          </li>
        </ul>
      </section>

      <section v-if="displayDescription" class="mb-8 space-y-2">
        <div class="flex items-center gap-2">
          <h2 class="text-base font-semibold">{{ $t('objektDetail.description') }}</h2>
          <span v-if="descriptionTranslated" class="text-xs text-muted-foreground">({{ $t('objektDetail.autoTranslatedHint') }})</span>
        </div>
        <p class="whitespace-pre-line text-sm text-foreground/90 leading-relaxed">
          {{ displayDescription }}
        </p>
      </section>
    </template>
    </div>
  </main>
</template>
