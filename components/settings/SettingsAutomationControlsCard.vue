<script setup lang="ts">
import { useSettingsAction } from '~/composables/settings/useSettingsAction'

interface AutomationSettings {
  crawlersEnabled: boolean
  llmEnabled: boolean
  /** Admin-set LLM calls per scheduled run; null = the env default applies. */
  llmMaxPerRun: number | null
  llmMaxPerRunDefault: number
  /** Candidates reprocessed in parallel; null = the env default applies. */
  llmConcurrency: number | null
  llmConcurrencyDefault: number
}

const { pending, error, run } = useSettingsAction()
const settings = ref<AutomationSettings>({ crawlersEnabled: true, llmEnabled: true, llmMaxPerRun: null, llmMaxPerRunDefault: 1, llmConcurrency: null, llmConcurrencyDefault: 1 })
// Drafts of the two number inputs; '' means "use the default".
const maxPerRunDraft = ref('')
const concurrencyDraft = ref('')
const MAX_PER_RUN_LIMIT = 1000
const CONCURRENCY_LIMIT = 8

function parseDraft(text: string, max: number): number | null | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isInteger(n) && n >= 1 && n <= max ? n : undefined
}
const maxPerRunValue = computed(() => parseDraft(maxPerRunDraft.value, MAX_PER_RUN_LIMIT))
const concurrencyValue = computed(() => parseDraft(concurrencyDraft.value, CONCURRENCY_LIMIT))
const budgetDirty = computed(() =>
  maxPerRunValue.value !== undefined && concurrencyValue.value !== undefined
  && (maxPerRunValue.value !== settings.value.llmMaxPerRun || concurrencyValue.value !== settings.value.llmConcurrency),
)

function applyLoaded(result: AutomationSettings): void {
  settings.value = result
  maxPerRunDraft.value = result.llmMaxPerRun == null ? '' : String(result.llmMaxPerRun)
  concurrencyDraft.value = result.llmConcurrency == null ? '' : String(result.llmConcurrency)
}

async function load(): Promise<void> {
  loaded.value = false
  const result = await run(
    () => $fetch<AutomationSettings>('/api/settings/automation'),
    'settings.automation.loadError',
  )
  if (!result) return
  applyLoaded(result)
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

async function saveBudget(): Promise<void> {
  if (maxPerRunValue.value === undefined || concurrencyValue.value === undefined) return
  const result = await run(
    () => $fetch<AutomationSettings>('/api/settings/automation', {
      method: 'PUT',
      body: { ...settings.value, llmMaxPerRun: maxPerRunValue.value, llmConcurrency: concurrencyValue.value },
    }),
    'settings.automation.saveError',
  )
  if (result) applyLoaded(result)
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
      <div class="space-y-3 rounded-md border p-3">
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-2">
            <Label for="llm-max-per-run" class="font-medium">{{ $t('settings.automation.maxPerRunLabel') }}</Label>
            <Input
              id="llm-max-per-run"
              v-model="maxPerRunDraft"
              type="number"
              min="1"
              :max="MAX_PER_RUN_LIMIT"
              step="1"
              :placeholder="String(settings.llmMaxPerRunDefault)"
              :disabled="!loaded || pending"
              @keydown.enter="saveBudget"
            />
            <p v-if="maxPerRunValue === undefined" class="text-xs text-destructive">{{ $t('settings.automation.rangeInvalid', { max: MAX_PER_RUN_LIMIT }) }}</p>
            <p class="text-xs text-muted-foreground">{{ $t('settings.automation.maxPerRunHelp', { default: settings.llmMaxPerRunDefault }) }}</p>
          </div>
          <div class="space-y-2">
            <Label for="llm-concurrency" class="font-medium">{{ $t('settings.automation.concurrencyLabel') }}</Label>
            <Input
              id="llm-concurrency"
              v-model="concurrencyDraft"
              type="number"
              min="1"
              :max="CONCURRENCY_LIMIT"
              step="1"
              :placeholder="String(settings.llmConcurrencyDefault)"
              :disabled="!loaded || pending"
              @keydown.enter="saveBudget"
            />
            <p v-if="concurrencyValue === undefined" class="text-xs text-destructive">{{ $t('settings.automation.rangeInvalid', { max: CONCURRENCY_LIMIT }) }}</p>
            <p class="text-xs text-muted-foreground">{{ $t('settings.automation.concurrencyHelp', { default: settings.llmConcurrencyDefault }) }}</p>
          </div>
        </div>
        <Button type="button" size="sm" :disabled="!loaded || pending || !budgetDirty" @click="saveBudget">{{ $t('settings.automation.budgetSave') }}</Button>
      </div>
      <p class="text-xs text-muted-foreground">{{ $t('settings.automation.manualHint') }}</p>
    </CardContent>
  </Card>
</template>
