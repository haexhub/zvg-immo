<script setup lang="ts">
import { useSettingsError } from '~/composables/settings/useSettingsError'
import type { CountrySourceSetting, CountrySourceSettings } from '~/server/utils/country-source-settings'

const { t } = useI18n()
const countryLabel = useCountryLabel()
const { normalizeSettingsError } = useSettingsError()
const emit = defineEmits<{ countries: [codes: string[]] }>()

const countrySources = ref<CountrySourceSetting[]>([])
const countrySourcesPending = ref(false)
const countrySourcesError = ref<string | null>(null)
const countrySourcesSaved = ref(false)
const countrySourcesLoaded = ref(false)
const enabledCountrySourceCount = computed(
  () => countrySources.value.filter((source) => source.enabled).length,
)

function publishEnabledCountries(): void {
  emit('countries', countrySources.value.filter((source) => source.enabled).map((source) => source.code))
}

async function loadCountrySources(): Promise<void> {
  try {
    const res = await $fetch<CountrySourceSettings>('/api/settings/countries')
    countrySources.value = res.countries
    countrySourcesLoaded.value = true
    countrySourcesError.value = null
    publishEnabledCountries()
  } catch (err) {
    countrySourcesLoaded.value = false
    countrySourcesError.value = normalizeSettingsError(err, t('settings.sources.loadError'))
  }
}

function toggleCountrySource(code: string): void {
  const source = countrySources.value.find((candidate) => candidate.code === code)
  if (source) source.enabled = !source.enabled
  countrySourcesSaved.value = false
}

async function saveCountrySources(): Promise<void> {
  if (!countrySourcesLoaded.value) return
  countrySourcesPending.value = true
  countrySourcesError.value = null
  countrySourcesSaved.value = false
  try {
    const res = await $fetch<CountrySourceSettings>('/api/settings/countries', {
      method: 'PUT',
      body: {
        enabledCountries: countrySources.value
          .filter((source) => source.enabled)
          .map((source) => source.code),
      },
    })
    countrySources.value = res.countries
    countrySourcesSaved.value = true
    publishEnabledCountries()
  } catch (err) {
    countrySourcesError.value = normalizeSettingsError(err, t('settings.sources.saveError'))
  } finally {
    countrySourcesPending.value = false
  }
}

onMounted(loadCountrySources)
</script>

<template>
  <section class="space-y-3">
    <div>
      <h3 class="text-sm font-semibold">{{ $t('settings.sources.title') }}</h3>
      <p class="mt-1 text-sm text-muted-foreground">{{ $t('settings.sources.description') }}</p>
    </div>
    <p v-if="countrySourcesError" class="text-sm text-destructive">{{ countrySourcesError }}</p>
    <p v-if="countrySourcesSaved" class="text-sm text-emerald-600 dark:text-emerald-500">{{ $t('settings.sources.saved') }}</p>
    <form class="space-y-3" @submit.prevent="saveCountrySources">
      <div class="max-h-80 overflow-y-auto rounded-md border divide-y">
        <SettingsCountryActionRow v-for="source in countrySources" :key="source.code">
          <template #leading>
            <Checkbox
              class="mt-0.5"
              :model-value="source.enabled"
              :disabled="countrySourcesPending"
              @update:model-value="toggleCountrySource(source.code)"
            />
          </template>
          <button type="button" class="min-w-0 w-full text-left disabled:cursor-not-allowed disabled:opacity-60" :disabled="countrySourcesPending" @click="toggleCountrySource(source.code)">
            <span class="block text-sm font-medium">
              {{ countryLabel(source.code, source.name) }}
              <span class="ml-1 font-mono text-xs uppercase text-muted-foreground">{{ source.code }}</span>
            </span>
            <span class="block text-xs text-muted-foreground">{{ source.platforms.map((platform) => platform.name).join(', ') }}</span>
          </button>
        </SettingsCountryActionRow>
      </div>
      <p class="text-xs text-muted-foreground">{{ $t('settings.sources.enabledCount', { enabled: enabledCountrySourceCount, total: countrySources.length }) }}</p>
      <Button type="submit" :disabled="countrySourcesPending || !countrySourcesLoaded">
        {{ countrySourcesPending ? $t('settings.sources.saving') : $t('settings.sources.save') }}
      </Button>
    </form>
  </section>
</template>
