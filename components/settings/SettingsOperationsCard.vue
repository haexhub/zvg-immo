<script setup lang="ts">
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-vue-next'
import { useSettingsError } from '~/composables/settings/useSettingsError'
import type { AppRuntimeStatus, HostOperationsStatus, MigrationStatus } from '~/server/utils/operations-status'

interface OperationsOverview {
  app: AppRuntimeStatus
  host: HostOperationsStatus
  now: string
}

const { t, locale } = useI18n()
const { normalizeSettingsError } = useSettingsError()
const status = ref<OperationsOverview | null>(null)
const pending = ref(false)
const loadError = ref<string | null>(null)
let refreshTimer: ReturnType<typeof setInterval> | undefined

function formatDate(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale.value === 'de' ? 'de-DE' : 'en-GB', {
    dateStyle: 'medium', timeStyle: 'medium',
  }).format(date)
}

function startsInLast15Minutes(starts: string[]): number {
  const threshold = Date.now() - 15 * 60 * 1000
  return starts.filter((entry) => new Date(entry).getTime() >= threshold).length
}

function isHostReportStale(reportedAt: string | null): boolean {
  return !reportedAt || Date.now() - new Date(reportedAt).getTime() > 5 * 60 * 1000
}

function migrationBadgeClass(migration: MigrationStatus): string {
  if (migration === 'ready') return 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300'
  if (migration === 'failed') return 'bg-destructive/15 text-destructive'
  if (migration === 'running') return 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
  return 'bg-muted text-muted-foreground'
}

function hostBadgeClass(): string {
  if (!isHostHealthy()) {
    return 'bg-destructive/15 text-destructive'
  }
  return 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300'
}

function isHostHealthy(): boolean {
  const host = status.value?.host
  return !!host?.available
    && !isHostReportStale(host.reportedAt)
    && host.app?.activeState === 'active'
    && (host.app.recentRestartCount ?? 0) < 3
}

async function load(): Promise<void> {
  if (pending.value) return

  pending.value = true
  loadError.value = null
  try {
    status.value = await $fetch<OperationsOverview>('/api/settings/operations', { cache: 'no-store' })
  } catch (err) {
    loadError.value = normalizeSettingsError(err, t('settings.operations.loadError'))
  } finally {
    pending.value = false
  }
}

onMounted(() => {
  void load()
  refreshTimer = setInterval(() => { void load() }, 60_000)
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>{{ $t('settings.operations.title') }}</CardTitle>
      <CardAction>
        <Button type="button" variant="ghost" size="icon-sm" :disabled="pending" :title="$t('settings.operations.refresh')" @click="load">
          <Loader2 v-if="pending" class="h-4 w-4 animate-spin" />
          <RefreshCw v-else class="h-4 w-4" />
        </Button>
      </CardAction>
    </CardHeader>
    <CardContent class="space-y-5">
      <p class="text-sm text-muted-foreground">{{ $t('settings.operations.description') }}</p>
      <p v-if="loadError" class="text-sm text-destructive">{{ loadError }}</p>

      <template v-if="status">
        <div class="grid gap-5 lg:grid-cols-2">
          <section class="space-y-3 rounded-lg border p-4">
            <div class="flex items-center justify-between gap-3">
              <h3 class="font-medium">{{ $t('settings.operations.app') }}</h3>
              <span class="rounded-full px-2 py-0.5 text-xs font-medium" :class="migrationBadgeClass(status.app.migration.status)">
                {{ $t(`settings.operations.status.${status.app.migration.status}`) }}
              </span>
            </div>
            <dl class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 text-sm">
              <dt class="text-muted-foreground">{{ $t('settings.operations.startedAt') }}</dt>
              <dd>{{ formatDate(status.app.startedAt) }}</dd>
              <dt class="text-muted-foreground">{{ $t('settings.operations.restarts15m') }}</dt>
              <dd :class="startsInLast15Minutes(status.app.recentStarts) >= 3 ? 'font-medium text-destructive' : ''">
                {{ startsInLast15Minutes(status.app.recentStarts) }}
              </dd>
              <dt class="text-muted-foreground">{{ $t('settings.operations.migration') }}</dt>
              <dd>{{ $t(`settings.operations.status.${status.app.migration.status}`) }}</dd>
              <dt class="text-muted-foreground">{{ $t('settings.operations.migrationUpdated') }}</dt>
              <dd>{{ formatDate(status.app.migration.updatedAt) }}</dd>
            </dl>
            <p v-if="status.app.migration.error" class="break-words rounded-md bg-destructive/10 p-2 text-sm text-destructive">
              {{ status.app.migration.error }}
            </p>
          </section>

          <section class="space-y-3 rounded-lg border p-4">
            <div class="flex items-center justify-between gap-3">
              <h3 class="font-medium">{{ $t('settings.operations.host') }}</h3>
              <span class="rounded-full px-2 py-0.5 text-xs font-medium" :class="hostBadgeClass()">
                {{ $t(`settings.operations.status.${isHostHealthy() ? 'healthy' : 'attention'}`) }}
              </span>
            </div>
            <p v-if="!status.host.available" class="text-sm text-muted-foreground">{{ $t('settings.operations.unavailable') }}</p>
            <template v-else>
              <p v-if="isHostReportStale(status.host.reportedAt)" class="flex items-center gap-2 text-sm text-destructive">
                <AlertTriangle class="h-4 w-4 shrink-0" /> {{ $t('settings.operations.stale') }}
              </p>
              <dl class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 text-sm">
                <dt class="text-muted-foreground">{{ $t('settings.operations.hostReportedAt') }}</dt>
                <dd>{{ formatDate(status.host.reportedAt) }}</dd>
                <dt class="text-muted-foreground">{{ $t('settings.operations.serviceState') }}</dt>
                <dd>{{ status.host.app?.activeState ?? '—' }}<template v-if="status.host.app?.subState"> / {{ status.host.app.subState }}</template></dd>
                <dt class="text-muted-foreground">{{ $t('settings.operations.restartCount') }}</dt>
                <dd :class="(status.host.app?.recentRestartCount ?? 0) >= 3 ? 'font-medium text-destructive' : ''">{{ status.host.app?.restartCount ?? '—' }}</dd>
                <dt class="text-muted-foreground">{{ $t('settings.operations.exitCode') }}</dt>
                <dd>{{ status.host.app?.exitCode ?? '—' }}</dd>
                <dt class="text-muted-foreground">{{ $t('settings.operations.database') }}</dt>
                <dd>{{ status.host.database?.activeState ?? '—' }}<template v-if="status.host.database?.subState"> / {{ status.host.database.subState }}</template></dd>
                <dt class="text-muted-foreground">{{ $t('settings.operations.sharedMemory') }}</dt>
                <dd>{{ status.host.database?.sharedMemoryBytes != null ? `${Math.round(status.host.database.sharedMemoryBytes / 1024 / 1024)} MiB` : '—' }}</dd>
              </dl>
            </template>
          </section>
        </div>

        <section class="space-y-2">
          <h3 class="font-medium">{{ $t('settings.operations.recentFailures') }}</h3>
          <p v-if="status.host.recentFailures.length === 0" class="text-sm text-muted-foreground">{{ $t('settings.operations.noFailures') }}</p>
          <ul v-else class="space-y-2">
            <li v-for="(failure, index) in status.host.recentFailures" :key="index" class="break-words rounded-md bg-destructive/10 p-2 text-sm text-destructive">
              {{ failure }}
            </li>
          </ul>
        </section>
      </template>
    </CardContent>
  </Card>
</template>
