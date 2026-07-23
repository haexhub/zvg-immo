<script setup lang="ts">
import { ALL_SCOPE } from '~/lib/auction-constants'
import { CONDITIONS } from '~/lib/condition'
import { FEATURES } from '~/lib/features'
import type { CountryEntry } from '~/server/crawlers/registry'

defineProps<{
  countries: CountryEntry[]
  selectedCountries: string[]
  availableRegions: Array<{ key: string; name: string; countryName: string }>
  selectedRegionKeys: string[]
  courts: string[]
  categories: Array<{ id: string; label: string; count: number }>
  currency: string
  pending: boolean
  activeFilterCount: number
}>()

const emit = defineEmits<{
  (e: 'toggle-country', code: string): void
  (e: 'toggle-region', key: string): void
  (e: 'set-price-bucket', min: number | null, max: number | null): void
  (e: 'clear-filters'): void
  (e: 'reload'): void
}>()

const authorityFilter = defineModel<string>('authorityFilter', { required: true })
const priceMinDisplay = defineModel<number | null>('priceMinDisplay', { required: true })
const priceMaxDisplay = defineModel<number | null>('priceMaxDisplay', { required: true })
const landAreaMin = defineModel<number | null>('landAreaMin', { required: true })
const landAreaMax = defineModel<number | null>('landAreaMax', { required: true })
const livingAreaMin = defineModel<number | null>('livingAreaMin', { required: true })
const livingAreaMax = defineModel<number | null>('livingAreaMax', { required: true })
const yearBuiltMin = defineModel<number | null>('yearBuiltMin', { required: true })
const yearBuiltMax = defineModel<number | null>('yearBuiltMax', { required: true })
const renovationYearMin = defineModel<number | null>('renovationYearMin', { required: true })
const renovationYearMax = defineModel<number | null>('renovationYearMax', { required: true })
const categoryFilter = defineModel<string>('categoryFilter', { required: true })
const conditionFilter = defineModel<string>('conditionFilter', { required: true })
const featuresFilter = defineModel<string[]>('featuresFilter', { required: true })
const onlyWithPhotos = defineModel<boolean>('onlyWithPhotos', { required: true })
const includeCancelled = defineModel<boolean>('includeCancelled', { required: true })

const { t } = useI18n()
const countryLabel = useCountryLabel()
const conditionLabel = useConditionLabel()
const featureLabel = useFeatureLabel()

function toggleFeature(id: string): void {
  const set = new Set(featuresFilter.value)
  if (set.has(id)) set.delete(id)
  else set.add(id)
  featuresFilter.value = [...set]
}

const priceBuckets = computed(() => [
  { label: t('search.priceBucket100k'), min: null, max: 100_000 },
  { label: t('search.priceBucket100to300k'), min: 100_000, max: 300_000 },
  { label: t('search.priceBucket300to600k'), min: 300_000, max: 600_000 },
  { label: t('search.priceBucket600k'), min: 600_000, max: null },
])
</script>

<template>
  <SheetHeader class="border-b px-5 py-3">
    <SheetTitle>{{ $t('filters.title') }}</SheetTitle>
    <SheetDescription class="sr-only">
      {{ $t('filters.description') }}
    </SheetDescription>
  </SheetHeader>

  <div class="flex-1 overflow-y-auto px-5 py-4 space-y-5">
    <div class="space-y-2">
      <Label>{{ $t('filters.country') }}</Label>
      <div class="max-h-48 overflow-y-auto rounded-md border divide-y">
        <label
          v-for="c in countries"
          :key="c.code"
          class="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-muted/50"
        >
          <Checkbox
            :model-value="selectedCountries.includes(c.code)"
            @update:model-value="emit('toggle-country', c.code)"
          />
          {{ countryLabel(c.code, c.name) }}
        </label>
      </div>
    </div>

    <div class="space-y-2">
      <Label>{{ $t('filters.region') }}</Label>
      <div v-if="availableRegions.length" class="max-h-48 overflow-y-auto rounded-md border divide-y">
        <label
          v-for="r in availableRegions"
          :key="r.key"
          class="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-muted/50"
        >
          <Checkbox
            :model-value="selectedRegionKeys.includes(r.key)"
            @update:model-value="emit('toggle-region', r.key)"
          />
          {{ r.name }}<span v-if="selectedCountries.length > 1" class="text-muted-foreground"> ({{ r.countryName }})</span>
        </label>
      </div>
      <p v-else class="text-xs text-muted-foreground">
        {{ $t('filters.regionHint') }}
      </p>
    </div>

    <div class="space-y-2">
      <Label>{{ $t('filters.authority') }}</Label>
      <Select v-model="authorityFilter">
        <SelectTrigger class="w-full">
          <SelectValue :placeholder="$t('filters.authorityPlaceholder')" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem :value="ALL_SCOPE">{{ $t('filters.allCourts') }}</SelectItem>
          <SelectItem v-for="c in courts" :key="c" :value="c">{{ c }}</SelectItem>
        </SelectContent>
      </Select>
    </div>

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
          class="rounded-full border px-3 py-0.5 text-xs text-muted-foreground hover:border-primary hover:text-primary transition-colors"
          @click="emit('set-price-bucket', p.min, p.max)"
        >{{ p.label }}</button>
      </div>
    </div>

    <div class="space-y-2">
      <Label>{{ $t('filters.landArea') }}</Label>
      <div class="flex items-center gap-2">
        <Input v-model.number="landAreaMin" type="number" min="0" step="50" :placeholder="$t('filters.from')" class="flex-1 min-w-0" />
        <span class="text-muted-foreground">–</span>
        <Input v-model.number="landAreaMax" type="number" min="0" step="50" :placeholder="$t('filters.to')" class="flex-1 min-w-0" />
      </div>
    </div>

    <div class="space-y-2">
      <Label>{{ $t('filters.livingArea') }}</Label>
      <div class="flex items-center gap-2">
        <Input v-model.number="livingAreaMin" type="number" min="0" step="10" :placeholder="$t('filters.from')" class="flex-1 min-w-0" />
        <span class="text-muted-foreground">–</span>
        <Input v-model.number="livingAreaMax" type="number" min="0" step="10" :placeholder="$t('filters.to')" class="flex-1 min-w-0" />
      </div>
    </div>

    <div class="space-y-2">
      <Label>{{ $t('filters.yearBuilt') }}</Label>
      <div class="flex items-center gap-2">
        <Input v-model.number="yearBuiltMin" type="number" min="1800" step="1" :placeholder="$t('filters.from')" class="flex-1 min-w-0" />
        <span class="text-muted-foreground">–</span>
        <Input v-model.number="yearBuiltMax" type="number" min="1800" step="1" :placeholder="$t('filters.to')" class="flex-1 min-w-0" />
      </div>
    </div>

    <div class="space-y-2">
      <Label>{{ $t('filters.renovationYear') }}</Label>
      <div class="flex items-center gap-2">
        <Input v-model.number="renovationYearMin" type="number" min="1800" step="1" :placeholder="$t('filters.from')" class="flex-1 min-w-0" />
        <span class="text-muted-foreground">–</span>
        <Input v-model.number="renovationYearMax" type="number" min="1800" step="1" :placeholder="$t('filters.to')" class="flex-1 min-w-0" />
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

    <div class="space-y-2">
      <Label>{{ $t('filters.condition') }}</Label>
      <Select v-model="conditionFilter">
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
            :model-value="featuresFilter.includes(f)"
            @update:model-value="toggleFeature(f)"
          />
          {{ featureLabel(f) }}
        </label>
      </div>
    </div>

    <div class="space-y-2 pt-2 border-t">
      <Label class="cursor-pointer">
        <Checkbox v-model="onlyWithPhotos" /> {{ $t('filters.onlyWithPhotos') }}
      </Label>
      <Label class="cursor-pointer">
        <Checkbox v-model="includeCancelled" /> {{ $t('filters.includeCancelled') }}
      </Label>
    </div>
  </div>

  <SheetFooter class="flex-row border-t px-5 py-3 sm:justify-stretch gap-2">
    <Button
      type="button"
      variant="outline"
      class="flex-1 border-destructive text-destructive hover:bg-destructive hover:text-white"
      :disabled="activeFilterCount === 0"
      @click="emit('clear-filters')"
    >
      {{ $t('filters.reset', { count: activeFilterCount }) }}
    </Button>
    <Button type="button" class="flex-1" :disabled="pending" @click="emit('reload')">
      {{ pending ? $t('filters.reloading') : $t('filters.reload') }}
    </Button>
  </SheetFooter>
</template>
