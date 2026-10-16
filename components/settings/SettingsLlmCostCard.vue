<script setup lang="ts">
import { Loader2, RefreshCw } from 'lucide-vue-next'
import { useSettingsAction } from '~/composables/settings/useSettingsAction'
import type { LlmCostOverview } from '~/server/utils/llm-usage'

const { pending, error, run } = useSettingsAction()
const overview = ref<LlmCostOverview | null>(null)
const loaded = ref(false)

const intlLocale = useIntlLocale()
const { t, te } = useI18n()

async function load(): Promise<void> {
  const res = await run(() => $fetch<LlmCostOverview>('/api/settings/llm-costs'), 'settings.llmCost.loadError')
  if (!res) return
  overview.value = res
  loaded.value = true
}

function formatCost(value: number | null): string {
  if (value == null) return '—'
  return value.toLocaleString(intlLocale.value, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 })
}
function formatTokens(value: number): string {
  return value.toLocaleString(intlLocale.value)
}
function taskLabel(task: string): string {
  const key = `settings.llmCost.task.${task}`
  return te(key) ? t(key) : task
}

onMounted(load)
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>{{ $t('settings.llmCost.title') }}</CardTitle>
      <CardAction>
        <Button type="button" variant="ghost" size="icon-sm" :disabled="pending" :title="$t('settings.llmCost.refresh')" @click="load">
          <Loader2 v-if="pending" class="h-4 w-4 animate-spin" />
          <RefreshCw v-else class="h-4 w-4" />
        </Button>
      </CardAction>
    </CardHeader>
    <CardContent class="space-y-4">
      <p class="text-sm text-muted-foreground">{{ $t('settings.llmCost.description') }}</p>
      <p v-if="error" class="text-sm text-destructive">{{ error }}</p>

      <div class="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        <div class="border rounded-md p-3">
          <div class="text-xs text-muted-foreground">{{ $t('settings.llmCost.statCost30d') }}</div>
          <div class="text-xl font-semibold tabular-nums">{{ formatCost(overview?.totalCostUsd ?? 0) }}</div>
        </div>
        <div class="border rounded-md p-3">
          <div class="text-xs text-muted-foreground">{{ $t('settings.llmCost.statCostToday') }}</div>
          <div class="text-xl font-semibold tabular-nums">{{ formatCost(overview?.todayCostUsd ?? 0) }}</div>
        </div>
        <div class="border rounded-md p-3">
          <div class="text-xs text-muted-foreground">{{ $t('settings.llmCost.statTokens') }}</div>
          <div class="text-xl font-semibold tabular-nums">
            {{ formatTokens((overview?.totalInputTokens ?? 0) + (overview?.totalOutputTokens ?? 0)) }}
          </div>
        </div>
        <div class="border rounded-md p-3">
          <div class="text-xs text-muted-foreground">{{ $t('settings.llmCost.statUnpriced') }}</div>
          <div class="text-xl font-semibold tabular-nums">{{ overview?.totalUnpricedCalls ?? 0 }}</div>
        </div>
      </div>

      <p v-if="!pending && loaded && (!overview || overview.breakdown.length === 0)" class="text-sm text-muted-foreground">
        {{ $t('settings.llmCost.empty') }}
      </p>

      <template v-if="overview && overview.daily.length > 0">
        <div class="text-sm font-medium">{{ $t('settings.llmCost.trendHeading') }}</div>
        <SettingsLlmCostChart :daily="overview.daily" />
      </template>

      <template v-if="overview && overview.breakdown.length > 0">
        <div class="text-sm font-medium">{{ $t('settings.llmCost.breakdownHeading') }}</div>
        <div class="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{{ $t('settings.llmCost.colTask') }}</TableHead>
                <TableHead>{{ $t('settings.llmCost.colModel') }}</TableHead>
                <TableHead>{{ $t('settings.llmCost.colProfile') }}</TableHead>
                <TableHead class="text-right">{{ $t('settings.llmCost.colCalls') }}</TableHead>
                <TableHead class="text-right">{{ $t('settings.llmCost.colTokens') }}</TableHead>
                <TableHead class="text-right">{{ $t('settings.llmCost.colCost') }}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="row in overview.breakdown" :key="`${row.task}:${row.provider}:${row.model}:${row.profileId}`">
                <TableCell class="whitespace-nowrap text-xs">{{ taskLabel(row.task) }}</TableCell>
                <TableCell class="whitespace-nowrap font-mono text-xs">
                  {{ row.model }}
                  <span class="text-muted-foreground">({{ row.provider }})</span>
                </TableCell>
                <TableCell class="whitespace-nowrap font-mono text-xs text-muted-foreground">{{ row.profileId ?? '—' }}</TableCell>
                <TableCell class="text-right tabular-nums text-xs">{{ row.callCount }}</TableCell>
                <TableCell class="text-right tabular-nums text-xs">{{ formatTokens(row.inputTokens + row.outputTokens) }}</TableCell>
                <TableCell class="text-right tabular-nums text-xs">
                  {{ formatCost(row.costUsd) }}
                  <span v-if="row.unpricedCallCount > 0" class="text-muted-foreground">
                    ({{ $t('settings.llmCost.unpricedCount', { count: row.unpricedCallCount }) }})
                  </span>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </template>
    </CardContent>
  </Card>
</template>
