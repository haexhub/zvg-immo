<script setup lang="ts">
import { useSettingsAction } from '~/composables/settings/useSettingsAction'

const { pending: displayPending, error: displayError, run } = useSettingsAction()

const hideRulesOnlyDefault = ref(true)
const displaySaved = ref(false)
const displayLoaded = ref(false)

async function loadDisplaySettings(): Promise<void> {
  displayLoaded.value = false
  const res = await run(() => $fetch<{ hideRulesOnlyAuctions: boolean }>('/api/settings/display'), 'settings.display.loadError')
  if (!res) return
  hideRulesOnlyDefault.value = res.hideRulesOnlyAuctions
  displayLoaded.value = true
}

async function saveDisplaySettings(): Promise<void> {
  displaySaved.value = false
  const res = await run(
    () => $fetch<{ hideRulesOnlyAuctions: boolean }>('/api/settings/display', {
      method: 'PUT',
      body: { hideRulesOnlyAuctions: hideRulesOnlyDefault.value },
    }),
    'settings.display.saveError',
  )
  if (!res) return
  hideRulesOnlyDefault.value = res.hideRulesOnlyAuctions
  displaySaved.value = true
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
