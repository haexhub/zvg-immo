<script setup lang="ts">
// Properties tab of the Airbnb-style search bar (see SearchBar.vue) —
// the property-attribute filters that used to live in the Sheet sidebar
// (SearchFilters.vue). Fields are staged in a local draft (useFilterDraft)
// and only written back to the real, URL-synced refs on "Anwenden" — typing
// a price used to fire a full re-search per keystroke (see
// composables/useAuctionSearchState.ts's query-sync watcher).
import { ALL_SCOPE } from '~/lib/auction-constants'
import { CONDITIONS } from '~/lib/condition'
import { FEATURES } from '~/lib/features'
import { useFilterDraft } from '~/composables/useFilterDraft'

const props = defineProps<{
  open: boolean
  categories: Array<{ id: string; label: string; count: number }>
  currency: string
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
}>()

const priceMin = defineModel<number | null>('priceMin', { required: true })
const priceMax = defineModel<number | null>('priceMax', { required: true })
const landAreaMin = defineModel<number | null>('landAreaMin', { required: true })
const landAreaMax = defineModel<number | null>('landAreaMax', { required: true })
const livingAreaMin = defineModel<number | null>('livingAreaMin', { required: true })
const livingAreaMax = defineModel<number | null>('livingAreaMax', { required: true })
const yearBuiltMin = defineModel<number | null>('yearBuiltMin', { required: true })
const yearBuiltMax = defineModel<number | null>('yearBuiltMax', { required: true })
const renovationYearMin = defineModel<number | null>('renovationYearMin', { required: true })
const renovationYearMax = defineModel<number | null>('renovationYearMax', { required: true })
const authorityFilter = defineModel<string>('authorityFilter', { required: true })
const categoryFilter = defineModel<string>('categoryFilter', { required: true })
const conditionFilter = defineModel<string>('conditionFilter', { required: true })
const featuresFilter = defineModel<string[]>('featuresFilter', { required: true })
const onlyWithPhotos = defineModel<boolean>('onlyWithPhotos', { required: true })
const includeCancelled = defineModel<boolean>('includeCancelled', { required: true })
const hideRulesOnly = defineModel<boolean>('hideRulesOnly', { required: true })

const { t } = useI18n()
const conditionLabel = useConditionLabel()
const featureLabel = useFeatureLabel()
const { eurToDisplay, displayToEur } = useCurrencyDisplay()

const isOpen = toRef(props, 'open')
const { draft, commit } = useFilterDraft({
  priceMin,
  priceMax,
  landAreaMin,
  landAreaMax,
  livingAreaMin,
  livingAreaMax,
  yearBuiltMin,
  yearBuiltMax,
  renovationYearMin,
  renovationYearMax,
  authorityFilter,
  categoryFilter,
  conditionFilter,
  featuresFilter,
  onlyWithPhotos,
  includeCancelled,
  hideRulesOnly,
}, isOpen)

const priceMinDisplay = computed<number | null>({
  get: () => { const d = eurToDisplay(draft.priceMin); return d != null ? Math.round(d) : null },
  set: (v) => { const e = displayToEur(v); draft.priceMin = e != null ? Math.round(e) : null },
})
const priceMaxDisplay = computed<number | null>({
  get: () => { const d = eurToDisplay(draft.priceMax); return d != null ? Math.round(d) : null },
  set: (v) => { const e = displayToEur(v); draft.priceMax = e != null ? Math.round(e) : null },
})

const priceBuckets = computed(() => [
  { label: t('search.priceBucket100k'), min: null, max: 100_000 },
  { label: t('search.priceBucket100to300k'), min: 100_000, max: 300_000 },
  { label: t('search.priceBucket300to600k'), min: 300_000, max: 600_000 },
  { label: t('search.priceBucket600k'), min: 600_000, max: null },
])
function setPriceBucket(min: number | null, max: number | null): void {
  draft.priceMin = min
  draft.priceMax = max
}

function toggleFeature(id: string): void {
  const set = new Set(draft.featuresFilter)
  if (set.has(id)) set.delete(id)
  else set.add(id)
  draft.featuresFilter = [...set]
}

const activeDraftCount = computed(() => {
  let n = 0
  if (!isAllScope(draft.authorityFilter)) n++
  if (draft.priceMin != null) n++
  if (draft.priceMax != null) n++
  if (draft.landAreaMin != null) n++
  if (draft.landAreaMax != null) n++
  if (draft.livingAreaMin != null) n++
  if (draft.livingAreaMax != null) n++
  if (draft.yearBuiltMin != null) n++
  if (draft.yearBuiltMax != null) n++
  if (draft.renovationYearMin != null) n++
  if (draft.renovationYearMax != null) n++
  if (!isAllScope(draft.categoryFilter)) n++
  if (!isAllScope(draft.conditionFilter)) n++
  if (draft.featuresFilter.length) n++
  if (draft.onlyWithPhotos) n++
  if (draft.includeCancelled) n++
  return n
})

function isAllScope(value: string): boolean {
  return value === ALL_SCOPE
}

function reset(): void {
  draft.priceMin = null
  draft.priceMax = null
  draft.landAreaMin = null
  draft.landAreaMax = null
  draft.livingAreaMin = null
  draft.livingAreaMax = null
  draft.yearBuiltMin = null
  draft.yearBuiltMax = null
  draft.renovationYearMin = null
  draft.renovationYearMax = null
  draft.authorityFilter = ALL_SCOPE
  draft.categoryFilter = ALL_SCOPE
  draft.conditionFilter = ALL_SCOPE
  draft.featuresFilter = []
  draft.onlyWithPhotos = false
  draft.includeCancelled = false
}

function apply(): void {
  commit()
  emit('update:open', false)
}
</script>

<template>
  <div class="flex h-full flex-col md:h-auto md:max-h-[70vh]">
    <div class="flex-1 overflow-y-auto space-y-6 p-1 pr-4 pb-4">
      <div class="space-y-2">
        <Label>{{ $t('filters.marketValue') }} ({{ currency }})</Label>
        <div class="flex items-center gap-2">
          <Input v-model.number="priceMinDisplay" type="number" min="0" step="10000" :placeholder="$t('filters.from')" class="flex-1 min-w-0" />
          <span class="text-muted-foreground">–</span>
          <Input v-model.number="priceMaxDisplay" type="number" min="0" step="10000" :placeholder="$t('filters.to')" class="flex-1 min-w-0" />
        </div>
        <div class="flex flex-wrap gap-1 pt-1">
          <button
            v-for="(p, i) in priceBuckets"
            :key="i"
            type="button"
            class="rounded-full border px-3 py-1 text-xs text-muted-foreground hover:border-primary hover:text-primary transition-colors"
            @click="setPriceBucket(p.min, p.max)"
          >{{ p.label }}</button>
        </div>
      </div>

      <div class="space-y-2">
        <Label>{{ $t('filters.landArea') }}</Label>
        <div class="flex items-center gap-2">
          <Input v-model.number="draft.landAreaMin" type="number" min="0" step="50" :placeholder="$t('filters.from')" class="flex-1 min-w-0" />
          <span class="text-muted-foreground">–</span>
          <Input v-model.number="draft.landAreaMax" type="number" min="0" step="50" :placeholder="$t('filters.to')" class="flex-1 min-w-0" />
        </div>
      </div>

      <div class="space-y-2">
        <Label>{{ $t('filters.livingArea') }}</Label>
        <div class="flex items-center gap-2">
          <Input v-model.number="draft.livingAreaMin" type="number" min="0" step="10" :placeholder="$t('filters.from')" class="flex-1 min-w-0" />
          <span class="text-muted-foreground">–</span>
          <Input v-model.number="draft.livingAreaMax" type="number" min="0" step="10" :placeholder="$t('filters.to')" class="flex-1 min-w-0" />
        </div>
      </div>

      <div class="space-y-2">
        <Label>{{ $t('filters.yearBuilt') }}</Label>
        <div class="flex items-center gap-2">
          <Input v-model.number="draft.yearBuiltMin" type="number" min="1800" step="1" :placeholder="$t('filters.from')" class="flex-1 min-w-0" />
          <span class="text-muted-foreground">–</span>
          <Input v-model.number="draft.yearBuiltMax" type="number" min="1800" step="1" :placeholder="$t('filters.to')" class="flex-1 min-w-0" />
        </div>
      </div>

      <div class="space-y-2">
        <Label>{{ $t('filters.renovationYear') }}</Label>
        <div class="flex items-center gap-2">
          <Input v-model.number="draft.renovationYearMin" type="number" min="1800" step="1" :placeholder="$t('filters.from')" class="flex-1 min-w-0" />
          <span class="text-muted-foreground">–</span>
          <Input v-model.number="draft.renovationYearMax" type="number" min="1800" step="1" :placeholder="$t('filters.to')" class="flex-1 min-w-0" />
        </div>
      </div>

      <div v-if="categories.length" class="space-y-2">
        <Label>{{ $t('filters.propertyType') }}</Label>
        <Select v-model="draft.categoryFilter">
          <SelectTrigger class="w-full">
            <SelectValue :placeholder="$t('filters.propertyTypePlaceholder')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="ALL_SCOPE">{{ $t('filters.allPropertyTypes') }}</SelectItem>
            <SelectItem v-for="k in categories" :key="k.id" :value="k.id">
              {{ k.label }} ({{ k.count }})
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="space-y-2">
        <Label>{{ $t('filters.condition') }}</Label>
        <Select v-model="draft.conditionFilter">
          <SelectTrigger class="w-full">
            <SelectValue :placeholder="$t('filters.conditionPlaceholder')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="ALL_SCOPE">{{ $t('filters.allConditions') }}</SelectItem>
            <SelectItem v-for="c in CONDITIONS" :key="c" :value="c">
              {{ conditionLabel(c) }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="space-y-2">
        <Label>{{ $t('filters.features') }}</Label>
        <div class="grid grid-cols-2 gap-x-2 gap-y-1">
          <label v-for="f in FEATURES" :key="f" class="flex items-center gap-2 cursor-pointer text-sm">
            <Checkbox
              :model-value="draft.featuresFilter.includes(f)"
              @update:model-value="toggleFeature(f)"
            />
            {{ featureLabel(f) }}
          </label>
        </div>
      </div>

      <div class="space-y-2 pt-3 border-t">
        <Label class="cursor-pointer">
          <Checkbox v-model="draft.onlyWithPhotos" /> {{ $t('filters.onlyWithPhotos') }}
        </Label>
        <Label class="cursor-pointer">
          <Checkbox v-model="draft.includeCancelled" /> {{ $t('filters.includeCancelled') }}
        </Label>
        <Label class="cursor-pointer">
          <Checkbox v-model="draft.hideRulesOnly" /> {{ $t('filters.hideRulesOnly') }}
        </Label>
      </div>
    </div>

    <div class="flex gap-3 border-t pt-4">
      <Button
        type="button"
        variant="outline"
        class="flex-1 border-destructive text-destructive hover:bg-destructive hover:text-white"
        :disabled="activeDraftCount === 0"
        @click="reset"
      >
        {{ $t('filters.reset', { count: activeDraftCount }) }}
      </Button>
      <Button type="button" class="flex-1" @click="apply">
        {{ $t('searchBar.apply') }}
      </Button>
    </div>
  </div>
</template>
