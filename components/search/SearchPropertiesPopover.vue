<script setup lang="ts">
// Properties tab of the Airbnb-style search bar (see SearchBar.vue) —
// the property-attribute filters that used to live in the Sheet sidebar
// (SearchFilters.vue). Every field writes straight to the real, URL-synced
// refs — select/checkbox/slider changes take effect immediately, and number
// inputs use `.lazy` so a re-search fires on blur rather than per keystroke
// (see composables/useAuctionSearchState.ts's query-sync watcher).
import { ALL_SCOPE } from '~/lib/auction-constants'
import { CONDITIONS } from '~/lib/condition'
import { FEATURES } from '~/lib/features'

const props = defineProps<{
  categories: Array<{ id: string; label: string; count: number }>
  platforms: Array<{ id: string; name: string }>
  currency: string
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
const categoryFilter = defineModel<string>('categoryFilter', { required: true })
const platformFilter = defineModel<string[]>('platformFilter', { required: true })
const conditionFilter = defineModel<string[]>('conditionFilter', { required: true })
const featuresFilter = defineModel<string[]>('featuresFilter', { required: true })
const onlyWithPhotos = defineModel<boolean>('onlyWithPhotos', { required: true })
const includeCancelled = defineModel<boolean>('includeCancelled', { required: true })
const hideRulesOnly = defineModel<boolean>('hideRulesOnly', { required: true })

const { t } = useI18n()
const conditionLabel = useConditionLabel()
const featureLabel = useFeatureLabel()
const { eurToDisplay, displayToEur } = useCurrencyDisplay()

const priceMinDisplay = computed<number | null>({
  get: () => { const d = eurToDisplay(priceMin.value); return d != null ? Math.round(d) : null },
  set: (v) => { const e = displayToEur(v); priceMin.value = e != null ? Math.round(e) : null },
})
const priceMaxDisplay = computed<number | null>({
  get: () => { const d = eurToDisplay(priceMax.value); return d != null ? Math.round(d) : null },
  set: (v) => { const e = displayToEur(v); priceMax.value = e != null ? Math.round(e) : null },
})

const priceBuckets = computed(() => [
  { label: t('search.priceBucket100k'), min: null, max: 100_000 },
  { label: t('search.priceBucket100to300k'), min: 100_000, max: 300_000 },
  { label: t('search.priceBucket300to600k'), min: 300_000, max: 600_000 },
  { label: t('search.priceBucket600k'), min: 600_000, max: null },
])
function setPriceBucket(min: number | null, max: number | null): void {
  priceMin.value = min
  priceMax.value = max
}

const conditionOptions = computed(() => CONDITIONS.map((c) => ({ value: c, label: conditionLabel(c) })))
const featureOptions = computed(() => FEATURES.map((f) => ({ value: f, label: featureLabel(f) })))
const platformOptions = computed(() => props.platforms.map((p) => ({ value: p.id, label: p.name })))
</script>

<template>
  <div class="flex h-full flex-col md:h-auto md:max-h-[70vh]">
    <div class="flex-1 overflow-y-auto space-y-6 p-1 pr-4 pb-4">
      <div class="space-y-2">
        <Label>{{ $t('filters.marketValue') }} ({{ currency }})</Label>
        <div class="flex items-center gap-2">
          <Input v-model.lazy.number="priceMinDisplay" type="number" min="0" step="10000" :placeholder="$t('filters.from')" class="flex-1 min-w-0" />
          <span class="text-muted-foreground">–</span>
          <Input v-model.lazy.number="priceMaxDisplay" type="number" min="0" step="10000" :placeholder="$t('filters.to')" class="flex-1 min-w-0" />
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
          <Input v-model.lazy.number="landAreaMin" type="number" min="0" step="50" :placeholder="$t('filters.from')" class="flex-1 min-w-0" />
          <span class="text-muted-foreground">–</span>
          <Input v-model.lazy.number="landAreaMax" type="number" min="0" step="50" :placeholder="$t('filters.to')" class="flex-1 min-w-0" />
        </div>
      </div>

      <div class="space-y-2">
        <Label>{{ $t('filters.livingArea') }}</Label>
        <div class="flex items-center gap-2">
          <Input v-model.lazy.number="livingAreaMin" type="number" min="0" step="10" :placeholder="$t('filters.from')" class="flex-1 min-w-0" />
          <span class="text-muted-foreground">–</span>
          <Input v-model.lazy.number="livingAreaMax" type="number" min="0" step="10" :placeholder="$t('filters.to')" class="flex-1 min-w-0" />
        </div>
      </div>

      <div class="space-y-2">
        <Label>{{ $t('filters.yearBuilt') }}</Label>
        <div class="flex items-center gap-2">
          <Input v-model.lazy.number="yearBuiltMin" type="number" min="1800" step="1" :placeholder="$t('filters.from')" class="flex-1 min-w-0" />
          <span class="text-muted-foreground">–</span>
          <Input v-model.lazy.number="yearBuiltMax" type="number" min="1800" step="1" :placeholder="$t('filters.to')" class="flex-1 min-w-0" />
        </div>
      </div>

      <div class="space-y-2">
        <Label>{{ $t('filters.renovationYear') }}</Label>
        <div class="flex items-center gap-2">
          <Input v-model.lazy.number="renovationYearMin" type="number" min="1800" step="1" :placeholder="$t('filters.from')" class="flex-1 min-w-0" />
          <span class="text-muted-foreground">–</span>
          <Input v-model.lazy.number="renovationYearMax" type="number" min="1800" step="1" :placeholder="$t('filters.to')" class="flex-1 min-w-0" />
        </div>
      </div>

      <div v-if="categories.length" class="space-y-2">
        <Label>{{ $t('filters.propertyType') }}</Label>
        <Select v-model="categoryFilter">
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

      <div v-if="platforms.length" class="space-y-2">
        <Label>{{ $t('filters.platform') }}</Label>
        <SearchFilterMultiSelect v-model="platformFilter" :options="platformOptions" :placeholder="$t('filters.allPlatforms')" />
      </div>

      <div class="space-y-2">
        <Label>{{ $t('filters.condition') }}</Label>
        <SearchFilterMultiSelect v-model="conditionFilter" :options="conditionOptions" :placeholder="$t('filters.allConditions')" />
      </div>

      <div class="space-y-2">
        <Label>{{ $t('filters.features') }}</Label>
        <SearchFilterMultiSelect v-model="featuresFilter" :options="featureOptions" :placeholder="$t('filters.allFeatures')" />
      </div>

      <div class="space-y-2 pt-3 border-t">
        <Label class="cursor-pointer">
          <Checkbox v-model="onlyWithPhotos" /> {{ $t('filters.onlyWithPhotos') }}
        </Label>
        <Label class="cursor-pointer">
          <Checkbox v-model="includeCancelled" /> {{ $t('filters.includeCancelled') }}
        </Label>
        <Label class="cursor-pointer">
          <Checkbox v-model="hideRulesOnly" /> {{ $t('filters.hideRulesOnly') }}
        </Label>
      </div>
    </div>
  </div>
</template>
