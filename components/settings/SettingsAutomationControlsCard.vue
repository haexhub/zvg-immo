<script setup lang="ts">
import { useSettingsAction } from '~/composables/settings/useSettingsAction'

interface AutomationSettings {
  crawlersEnabled: boolean
  llmEnabled: boolean
  /** Admin-set LLM calls per scheduled run; null = the env default applies. */
  llmMaxPerRun: number | null
  llmMaxPerRunDefault: number
}

const { pending, error, run } = useSettingsAction()
const settings = ref<AutomationSettings>({ crawlersEnabled: true, llmEnabled: true, llmMaxPerRun: null, llmMaxPerRunDefault: 1 })
// Draft of the cap input; '' means "use the default".
const maxPerRunDraft = ref('')
const MAX_PER_RUN_LIMIT = 1000
const draftValue = computed<number | null | undefined>(() => {
  const text = maxPerRunDraft.value.trim()
  if (text === '') return null
  const n = Number(text)
  return Number.isInteger(n) && n >= 1 && n <= MAX_PER_RUN_LIMIT ? n : undefined
})
const draftDirty = computed(() => draftValue.value !== undefined && draftValue.value !== settings.value.llmMaxPerRun)
const loaded = ref(false)

async function load(): Promise<void> {
  loaded.value = false
  const result = await run(
    () => $fetch<AutomationSettings>('/api/settings/automation'),
    'settings.automation.loadError',
  )
  if (!result) return
  settings.value = result
  maxPerRunDraft.value = result.llmMaxPerRun == null ? '' : String(result.llmMaxPerRun)
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

async function saveMaxPerRun(): Promise<void> {
  if (draftValue.value === undefined) return
  const result = await run(
    () => $fetch<AutomationSettings>('/api/settings/automation', { method: 'PUT', body: { ...settings.value, llmMaxPerRun: draftValue.value } }),
    'settings.automation.saveError',
  )
  if (!result) return
  settings.value = result
  maxPerRunDraft.value = result.llmMaxPerRun == null ? '' : String(result.llmMaxPerRun)
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
      <div class="space-y-2 rounded-md border p-3">
        <Label for="llm-max-per-run" class="font-medium">{{ $t('settings.automation.maxPerRunLabel') }}</Label>
        <div class="flex items-center gap-2">
          <Input
            id="llm-max-per-run"
            v-model="maxPerRunDraft"
            type="number"
            min="1"
            :max="MAX_PER_RUN_LIMIT"
            step="1"
            class="w-32"
            :placeholder="String(settings.llmMaxPerRunDefault)"
            :disabled="!loaded || pending"
            @keydown.enter="saveMaxPerRun"
          />
          <Button type="button" size="sm" :disabled="!loaded || pending || !draftDirty" @click="saveMaxPerRun">{{ $t('settings.automation.maxPerRunSave') }}</Button>
        </div>
        <p v-if="draftValue === undefined" class="text-xs text-destructive">{{ $t('settings.automation.maxPerRunInvalid', { max: MAX_PER_RUN_LIMIT }) }}</p>
        <p class="text-xs text-muted-foreground">{{ $t('settings.automation.maxPerRunHelp', { default: settings.llmMaxPerRunDefault }) }}</p>
      </div>
      <p class="text-xs text-muted-foreground">{{ $t('settings.automation.manualHint') }}</p>
    </CardContent>
  </Card>
</template>
