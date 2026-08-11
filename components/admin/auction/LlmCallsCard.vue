<script setup lang="ts">
import type { AuctionLlmCallRow } from '~/server/utils/auction-technical'
import { formatCost } from '~/lib/auction-technical-helpers'

const props = defineProps<{
  calls: AuctionLlmCallRow[]
  formatDate: (value: string | null) => string
}>()

const { locale } = useI18n()
const formatTokens = (input: number | null, output: number | null): string =>
  input == null && output == null ? '—' : `${input ?? '—'} / ${output ?? '—'}`
</script>

<template>
  <Card>
    <CardHeader><CardTitle>{{ $t('settings.auctionTechnical.sections.llmCalls') }}</CardTitle></CardHeader>
    <CardContent>
      <Table v-if="props.calls.length">
        <TableHeader>
          <TableRow>
            <TableHead>{{ $t('settings.auctionTechnical.fields.provider') }}</TableHead>
            <TableHead>{{ $t('settings.auctionTechnical.fields.executionMode') }}</TableHead>
            <TableHead>{{ $t('settings.auctionTechnical.fields.status') }}</TableHead>
            <TableHead>{{ $t('settings.auctionTechnical.fields.tokens') }}</TableHead>
            <TableHead>{{ $t('settings.auctionTechnical.fields.cost') }}</TableHead>
            <TableHead>{{ $t('settings.auctionTechnical.fields.duration') }}</TableHead>
            <TableHead>{{ $t('settings.auctionTechnical.fields.createdAt') }}</TableHead>
            <TableHead>{{ $t('settings.auctionTechnical.fields.error') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="call in props.calls" :key="call.id">
            <TableCell>{{ `${call.provider}/${call.model}` }}</TableCell>
            <TableCell>{{ call.executionMode }}</TableCell>
            <TableCell><Badge :variant="call.status === 'failed' ? 'destructive' : 'default'">{{ call.status }}</Badge></TableCell>
            <TableCell>{{ formatTokens(call.inputTokens, call.outputTokens) }}</TableCell>
            <TableCell>{{ formatCost(call.costUsd, locale) }}</TableCell>
            <TableCell>{{ call.durationMs != null ? `${call.durationMs} ms` : '—' }}</TableCell>
            <TableCell>{{ props.formatDate(call.occurredAt) }}</TableCell>
            <TableCell class="max-w-md text-destructive">{{ call.errorMessage ?? '—' }}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <p v-else class="text-sm text-muted-foreground">{{ $t('settings.auctionTechnical.noData') }}</p>
    </CardContent>
  </Card>
</template>
