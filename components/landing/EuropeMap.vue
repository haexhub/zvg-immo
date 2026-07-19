<script setup lang="ts">
import europeMapData from '~/assets/data/europe-map.json'
import type { CountryEntry } from '~/server/crawlers/registry'

const props = defineProps<{ countries: CountryEntry[] }>()

const router = useRouter()
const countryLabel = useCountryLabel()

const availableCodes = computed(() => new Set(props.countries.map((c) => c.code)))
const isAvailable = (code: string) => availableCodes.value.has(code)

function selectCountry(code: string) {
  if (!isAvailable(code)) return
  router.push({ path: '/search', query: { country: code } })
}
</script>

<template>
  <svg
    :viewBox="europeMapData.viewBox"
    class="h-auto w-full select-none"
    role="img"
    :aria-label="$t('landing.hero.mapLabel')"
  >
    <path
      v-for="c in europeMapData.countries"
      :key="c.code"
      :d="c.path"
      class="stroke-background transition-colors"
      :class="isAvailable(c.code)
        ? 'fill-amber-500 hover:fill-amber-600 cursor-pointer'
        : 'fill-muted-foreground/15 cursor-default'"
      :tabindex="isAvailable(c.code) ? 0 : -1"
      :role="isAvailable(c.code) ? 'link' : undefined"
      @click="selectCountry(c.code)"
      @keydown.enter="selectCountry(c.code)"
    >
      <title>{{ countryLabel(c.code, c.name) }}</title>
    </path>
  </svg>
</template>
