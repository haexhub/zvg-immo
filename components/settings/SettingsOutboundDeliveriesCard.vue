<script setup lang="ts">
import { useSettingsAction } from '~/composables/settings/useSettingsAction'

interface Overview {
  pending: number
  processing: number
  failed: number
  recentFailures: Array<{ kind: string; attempts: number; lastErrorClass: string | null; createdAt: string }>
}

const overview = ref<Overview | null>(null)
const { pending, error, run } = useSettingsAction()

async function load(): Promise<void> {
  const result = await run(
    () => $fetch<Overview>('/api/settings/outbound-deliveries', { cache: 'no-store' }),
    'settings.outbound.loadError',
  )
  if (result) overview.value = result
}

onMounted(load)
</script>

<template>
  <Card>
    <CardHeader class="flex-row items-center justify-between space-y-0">
      <div>
        <CardTitle>{{ $t('settings.outbound.title') }}</CardTitle>
        <p class="text-sm text-muted-foreground">{{ $t('settings.outbound.description') }}</p>
      </div>
      <Button variant="outline" size="sm" :disabled="pending" @click="load">{{ $t('settings.outbound.refresh') }}</Button>
    </CardHeader>
    <CardContent class="space-y-3">
      <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
      <div v-else-if="overview" class="flex gap-5 text-sm">
        <span>{{ $t('settings.outbound.pending', { count: overview.pending }) }}</span>
        <span>{{ $t('settings.outbound.processing', { count: overview.processing }) }}</span>
        <span :class="overview.failed ? 'text-destructive' : ''">{{ $t('settings.outbound.failed', { count: overview.failed }) }}</span>
      </div>
      <ul v-if="overview?.recentFailures.length" class="space-y-1 text-xs text-muted-foreground">
        <li v-for="failure in overview.recentFailures" :key="`${failure.kind}-${failure.createdAt}`">
          {{ failure.kind }} · {{ $t('settings.outbound.attempt', { count: failure.attempts }) }} · {{ failure.lastErrorClass ?? $t('settings.outbound.unknownError') }} · {{ failure.createdAt }}
        </li>
      </ul>
    </CardContent>
  </Card>
</template>
