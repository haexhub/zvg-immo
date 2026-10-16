<script setup lang="ts">
import { useSettingsAction } from '~/composables/settings/useSettingsAction'

const { pending, error, run } = useSettingsAction()

const enabled = ref(false)
const loaded = ref(false)

async function load(): Promise<void> {
  loaded.value = false
  const res = await run(() => $fetch<{ enabled: boolean }>('/api/settings/llm-kill-switch'), 'settings.llmKillSwitch.loadError')
  if (!res) return
  enabled.value = res.enabled
  loaded.value = true
}

// Applies immediately on toggle — no separate save step, since the whole
// point is stopping every LLM call as fast as possible in an incident.
async function toggle(next: boolean): Promise<void> {
  const previous = enabled.value
  enabled.value = next
  const res = await run(
    () => $fetch<{ enabled: boolean }>('/api/settings/llm-kill-switch', { method: 'PUT', body: { enabled: next } }),
    'settings.llmKillSwitch.saveError',
  )
  enabled.value = res ? res.enabled : previous
}

onMounted(load)
</script>

<template>
  <Card :class="enabled ? 'border-destructive' : undefined">
    <CardHeader>
      <CardTitle class="flex items-center gap-2">
        {{ $t('settings.llmKillSwitch.title') }}
        <Badge :variant="enabled ? 'destructive' : 'secondary'">
          {{ enabled ? $t('settings.llmKillSwitch.statusOn') : $t('settings.llmKillSwitch.statusOff') }}
        </Badge>
      </CardTitle>
    </CardHeader>
    <CardContent class="space-y-4">
      <p class="text-sm text-muted-foreground">
        {{ $t('settings.llmKillSwitch.description') }}
      </p>

      <div v-if="error" class="flex items-center gap-2">
        <p class="text-sm text-destructive">{{ error }}</p>
        <Button v-if="!loaded" type="button" size="sm" variant="outline" @click="load">
          {{ $t('settings.llmKillSwitch.retry') }}
        </Button>
      </div>

      <Label class="flex items-center gap-2">
        <Checkbox
          :model-value="enabled"
          :disabled="!loaded || pending"
          @update:model-value="(value) => toggle(value === true)"
        />
        {{ $t('settings.llmKillSwitch.label') }}
      </Label>
    </CardContent>
  </Card>
</template>
