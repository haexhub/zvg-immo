<script setup lang="ts">
import { useSettingsError } from '~/composables/settings/useSettingsError'

const { t } = useI18n()
const { normalizeSettingsError } = useSettingsError()

const hideRulesOnlyDefault = ref(true)
const displayError = ref<string | null>(null)
const displaySaved = ref(false)
const displayPending = ref(false)
const displayLoaded = ref(false)

async function loadDisplaySettings(): Promise<void> {
  displayLoaded.value = false
  try {
    const res = await $fetch<{ hideRulesOnlyAuctions: boolean }>('/api/settings/display')
    hideRulesOnlyDefault.value = res.hideRulesOnlyAuctions
    displayError.value = null
    displayLoaded.value = true
  } catch (err) {
    displayError.value = normalizeSettingsError(err, t('settings.display.loadError'))
  }
}

async function saveDisplaySettings(): Promise<void> {
  displayPending.value = true
  displayError.value = null
  displaySaved.value = false
  try {
    const res = await $fetch<{ hideRulesOnlyAuctions: boolean }>('/api/settings/display', {
      method: 'PUT',
      body: { hideRulesOnlyAuctions: hideRulesOnlyDefault.value },
    })
    hideRulesOnlyDefault.value = res.hideRulesOnlyAuctions
    displaySaved.value = true
  } catch (err) {
    displayError.value = normalizeSettingsError(err, t('settings.display.saveError'))
  } finally {
    displayPending.value = false
  }
}

onMounted(loadDisplaySettings)
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>{{ $t('settings.display.title') }}</CardTitle>
    </CardHeader>
    <CardContent class="space-y-4">
      <p class="text-sm text-muted-foreground">
        {{ $t('settings.display.description') }}
      </p>

      <div v-if="displayError" class="flex items-center gap-2">
        <p class="text-sm text-destructive">{{ displayError }}</p>
        <Button v-if="!displayLoaded" type="button" size="sm" variant="outline" @click="loadDisplaySettings">
          {{ $t('settings.display.retry') }}
        </Button>
      </div>
      <p v-if="displaySaved" class="text-sm text-emerald-600 dark:text-emerald-500">{{ $t('settings.display.saved') }}</p>

      <form class="space-y-3" @submit.prevent="saveDisplaySettings">
        <Label class="flex items-center gap-2">
          <Checkbox v-model="hideRulesOnlyDefault" :disabled="!displayLoaded || displayPending" /> {{ $t('settings.display.hideRulesOnlyLabel') }}
        </Label>
        <Button type="submit" :disabled="!displayLoaded || displayPending">
          {{ displayPending ? $t('settings.display.saving') : $t('settings.display.save') }}
        </Button>
      </form>
    </CardContent>
  </Card>
</template>
