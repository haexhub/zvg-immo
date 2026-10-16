<script setup lang="ts">
import { useSettingsAction } from '~/composables/settings/useSettingsAction'
import type { LlmMaxTokensKind } from '~/server/utils/app-settings'

type LlmMaxTokensDraft = string | number

const { t, te } = useI18n()
const { pending: llmConfigPending, error: llmConfigError, run } = useSettingsAction()

const llmConfig = ref<Record<LlmMaxTokensKind, LlmMaxTokensDraft>>({})
const llmConfigSaved = ref(false)
const llmConfigLoaded = ref(false)
const llmConfigSaveDisabled = computed(
  () => llmConfigPending.value || !llmConfigLoaded.value || Object.keys(llmConfig.value).length === 0,
)

function llmKindLabel(kind: string): string {
  const key = `settings.llm.${kind}Label`
  return te(key) ? t(key) : kind
}

async function loadLlmConfig(): Promise<void> {
  const res = await run(() => $fetch<Record<LlmMaxTokensKind, number>>('/api/settings/llm-config'), 'settings.llm.loadError')
  if (!res) return
  llmConfig.value = Object.fromEntries(Object.entries(res).map(([kind, value]) => [kind, String(value)]))
  llmConfigLoaded.value = true
}

function parseLlmMaxTokens(raw: LlmMaxTokensDraft): number | null {
  const normalized = typeof raw === 'number' ? String(raw) : raw.trim()
  if (normalized === '') return null
  const value = Number(normalized)
  return Number.isFinite(value) ? value : null
}

async function saveLlmConfig(): Promise<void> {
  const parsed: Record<string, number> = {}
  for (const [kind, raw] of Object.entries(llmConfig.value)) {
    const value = parseLlmMaxTokens(raw)
    if (value === null) {
      llmConfigError.value = t('settings.llm.invalidValue')
      return
    }
    parsed[kind] = value
  }

  llmConfigSaved.value = false
  const res = await run(
    () => $fetch<Record<LlmMaxTokensKind, number>>('/api/settings/llm-config', { method: 'PUT', body: parsed }),
    'settings.llm.saveError',
  )
  if (!res) return
  llmConfig.value = Object.fromEntries(Object.entries(res).map(([kind, value]) => [kind, String(value)]))
  llmConfigSaved.value = true
}

onMounted(loadLlmConfig)
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>{{ $t('settings.llm.title') }}</CardTitle>
    </CardHeader>
    <CardContent class="space-y-4">
      <p class="text-sm text-muted-foreground">
        {{ $t('settings.llm.description') }}
      </p>

      <p v-if="llmConfigError" class="text-sm text-destructive">{{ llmConfigError }}</p>
      <p v-if="llmConfigSaved" class="text-sm text-emerald-600 dark:text-emerald-500">{{ $t('settings.llm.saved') }}</p>

      <form class="grid grid-cols-1 sm:grid-cols-2 gap-3" @submit.prevent="saveLlmConfig">
        <div v-for="kind in Object.keys(llmConfig)" :key="kind" class="space-y-1">
          <Label>{{ llmKindLabel(kind) }}</Label>
          <Input v-model="llmConfig[kind]" type="number" min="256" max="32768" step="1" />
        </div>
        <div class="sm:col-span-2">
          <Button type="submit" :disabled="llmConfigSaveDisabled">
            {{ llmConfigPending ? $t('settings.llm.saving') : $t('settings.llm.save') }}
          </Button>
        </div>
      </form>
    </CardContent>
  </Card>
</template>
