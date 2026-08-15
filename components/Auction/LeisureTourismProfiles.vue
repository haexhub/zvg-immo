<script setup lang="ts">
// GIS WP-8 (docs/plans/2026-08-04-gis-wp8-lagebeschreibung.md): renders the
// two Nutzungsprofile from server/utils/leisure-tourism-profile.ts. Every
// criterion is always shown, including a "gering" band from a NULL distance
// — hiding it would repeat the doc's warned-against pitfall of quietly
// dropping "nothing of this kind nearby" instead of stating it.
import type { LeisureTourismCriterion, LeisureTourismProfiles, ProfileLabel } from '~/server/utils/leisure-tourism-profile'
import { useAuctionDetailFormatters } from '~/composables/useAuctionDetailFormatters'

const props = defineProps<{ profiles: LeisureTourismProfiles }>()

const { t } = useI18n()
const { formatDistance } = useAuctionDetailFormatters()

const PROFILE_KEYS = ['eigennutzung', 'wirtschaftlich'] as const
const activeProfile = ref<(typeof PROFILE_KEYS)[number]>('eigennutzung')
const current = computed(() => props.profiles[activeProfile.value])

function bandLabel(band: ProfileLabel): string {
  return t(`objektDetail.leisureTourismBand.${band}`)
}

function bandClass(band: ProfileLabel): string {
  if (band === 'sehr_gut') return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  if (band === 'gut') return 'border-sky-200 bg-sky-50 text-sky-700'
  if (band === 'maessig') return 'border-amber-200 bg-amber-50 text-amber-700'
  return 'border-slate-200 bg-slate-50 text-slate-700'
}

interface CriterionRow {
  key: string
  label: string
  criterion: LeisureTourismCriterion
  isCount: boolean
}

const criteriaRows = computed<CriterionRow[]>(() => {
  const c = current.value.criteria
  if (!c) return []
  const waterLabelKey = c.wasser.source === 'sea'
    ? 'leisureTourismSea'
    : c.wasser.source === 'lake'
      ? 'leisureTourismLake'
      : 'leisureTourismWater'
  return [
    { key: 'ski', label: t('objektDetail.leisureTourismSki'), criterion: c.ski, isCount: false },
    { key: 'wasser', label: t(`objektDetail.${waterLabelKey}`), criterion: c.wasser, isCount: false },
    { key: 'wandern', label: t('objektDetail.leisureTourismHiking'), criterion: c.wandern, isCount: false },
    { key: 'tourismusDichte', label: t('objektDetail.leisureTourismDensity'), criterion: c.tourismusDichte, isCount: true },
    { key: 'sehenswuerdigkeiten', label: t('objektDetail.leisureTourismAttractions'), criterion: c.sehenswuerdigkeiten, isCount: true },
  ]
})

function formatCriterionValue(row: CriterionRow): string {
  if (row.isCount) return row.criterion.value == null ? '–' : String(row.criterion.value)
  return formatDistance(row.criterion.value)
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap gap-2" role="tablist">
      <button
        v-for="key in PROFILE_KEYS"
        :key="key"
        type="button"
        role="tab"
        :aria-selected="activeProfile === key"
        class="rounded-full px-3 py-1 text-sm font-medium transition-colors"
        :class="activeProfile === key
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted text-muted-foreground hover:bg-muted/70'"
        @click="activeProfile = key"
      >
        {{ t(`objektDetail.leisureTourismProfile.${key}`) }}
      </button>
    </div>

    <p v-if="current.label === 'keine_angaben'" class="text-sm text-muted-foreground">
      {{ t('objektDetail.leisureTourismUnavailable') }}
    </p>
    <div v-else class="space-y-3">
      <Badge variant="outline" :class="bandClass(current.label)">{{ bandLabel(current.label) }}</Badge>
      <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
        <div v-for="row in criteriaRows" :key="row.key">
          <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ row.label }}</dt>
          <dd class="flex flex-wrap items-center gap-2 font-medium">
            <span>{{ formatCriterionValue(row) }}</span>
            <Badge variant="outline" class="text-xs" :class="bandClass(row.criterion.band)">{{ bandLabel(row.criterion.band) }}</Badge>
          </dd>
        </div>
      </dl>
      <p class="text-xs text-muted-foreground">{{ t('objektDetail.leisureTourismDisclaimer') }}</p>
    </div>
  </div>
</template>
