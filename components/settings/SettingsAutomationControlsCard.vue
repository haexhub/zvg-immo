<script setup lang="ts">
import { useSettingsAction } from '~/composables/settings/useSettingsAction'

interface AutomationSettings {
  crawlersEnabled: boolean
  llmEnabled: boolean
}

const { pending, error, run } = useSettingsAction()
const settings = ref<AutomationSettings>({ crawlersEnabled: true, llmEnabled: true })
const loaded = ref(false)

async function load(): Promise<void> {
  loaded.value = false
  const result = await run(
    () => $fetch<AutomationSettings>('/api/settings/automation'),
    'settings.automation.loadError',
  )
  if (!result) return
  settings.value = result
  loaded.value = true
}

async function update(key: keyof AutomationSettings, value: boolean): Promise<void> {
  const previous = settings.value
  settings.value = { ...settings.value, [key]: value }
  const result = await run(
    () => $fetch<AutomationSettings>('/api/settings/automation', { method: 'PUT', body: settings.value }),
    'settings.automation.saveError',
  )
  settings.value = result ?? previous
}

onMounted(load)
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>{{ $t('settings.automation.title') }}</CardTitle>
    </CardHeader>
    <CardContent class="space-y-4">
      <p class="text-sm text-muted-foreground">{{ $t('settings.automation.description') }}</p>
      <div v-if="error" class="flex items-center gap-2">
        <p class="text-sm text-destructive">{{ error }}</p>
        <Button type="button" variant="outline" size="sm" :disabled="pending" @click="load">{{ $t('settings.automation.retry') }}</Button>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <Label class="flex items-start gap-3 rounded-md border p-3" :class="{ 'opacity-60': !settings.crawlersEnabled }">
          <Checkbox :model-value="settings.crawlersEnabled" :disabled="!loaded || pending" @update:model-value="(value) => update('crawlersEnabled', value === true)" />
          <span class="space-y-1"><span class="block font-medium">{{ $t('settings.automation.crawlersLabel') }}</span><span class="block text-xs font-normal text-muted-foreground">{{ $t('settings.automation.crawlersHelp') }}</span></span>
        </Label>
        <Label class="flex items-start gap-3 rounded-md border p-3" :class="{ 'opacity-60': !settings.llmEnabled }">
          <Checkbox :model-value="settings.llmEnabled" :disabled="!loaded || pending" @update:model-value="(value) => update('llmEnabled', value === true)" />
          <span class="space-y-1"><span class="block font-medium">{{ $t('settings.automation.llmLabel') }}</span><span class="block text-xs font-normal text-muted-foreground">{{ $t('settings.automation.llmHelp') }}</span></span>
        </Label>
      </div>
      <p class="text-xs text-muted-foreground">{{ $t('settings.automation.manualHint') }}</p>
    </CardContent>
  </Card>
</template>
