<script setup lang="ts">
interface Overview {
  pending: number
  processing: number
  failed: number
  recentFailures: Array<{ kind: string; attempts: number; lastErrorClass: string | null; createdAt: string }>
}

const overview = ref<Overview | null>(null)
const error = ref<string | null>(null)

async function load(): Promise<void> {
  error.value = null
  try {
    overview.value = await $fetch<Overview>('/api/settings/outbound-deliveries', { cache: 'no-store' })
  } catch (err) {
    error.value = (err as Error).message || 'Zustand konnte nicht geladen werden.'
  }
}

onMounted(load)
</script>

<template>
  <Card>
    <CardHeader class="flex-row items-center justify-between space-y-0">
      <div>
        <CardTitle>Ausgehende Nachrichten</CardTitle>
        <p class="text-sm text-muted-foreground">Zustand der langlebigen Mail-Outbox; Inhalte und Empfänger bleiben verborgen.</p>
      </div>
      <Button variant="outline" size="sm" @click="load">Aktualisieren</Button>
    </CardHeader>
    <CardContent class="space-y-3">
      <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
      <div v-else-if="overview" class="flex gap-5 text-sm">
        <span>Ausstehend: {{ overview.pending }}</span>
        <span>In Arbeit: {{ overview.processing }}</span>
        <span :class="overview.failed ? 'text-destructive' : ''">Dauerhaft fehlgeschlagen: {{ overview.failed }}</span>
      </div>
      <ul v-if="overview?.recentFailures.length" class="space-y-1 text-xs text-muted-foreground">
        <li v-for="failure in overview.recentFailures" :key="`${failure.kind}-${failure.createdAt}`">
          {{ failure.kind }} · Versuch {{ failure.attempts }} · {{ failure.lastErrorClass ?? 'unknown' }} · {{ failure.createdAt }}
        </li>
      </ul>
    </CardContent>
  </Card>
</template>
