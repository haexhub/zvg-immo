<script setup lang="ts">
import type { AuctionTechnicalOverview } from '~/server/utils/auction-technical'

defineProps<{
  overview: AuctionTechnicalOverview
  formatDate: (value: string | null) => string
}>()
</script>

<template>
  <Card>
    <CardHeader><CardTitle>{{ $t('settings.auctionTechnical.sections.identity') }}</CardTitle></CardHeader>
    <CardContent class="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
      <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.country') }}</div><div>{{ overview.identity.country }} / {{ overview.identity.region }}</div></div>
      <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.authority') }}</div><div>{{ overview.identity.authority }}</div></div>
      <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.caseNumber') }}</div><div>{{ overview.identity.caseNumber }}</div></div>
      <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.coordinates') }}</div><div>{{ overview.identity.lat ?? '—' }}, {{ overview.identity.lng ?? '—' }}</div></div>
      <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.geocodeResult') }}</div><div>{{ overview.identity.geocodeResult ?? '—' }} ({{ overview.identity.geocodeProvider ?? '—' }})</div></div>
      <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.geocodeAttemptedAt') }}</div><div>{{ formatDate(overview.identity.geocodeAttemptedAt) }}</div></div>
      <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.firstSeenAt') }}</div><div>{{ formatDate(overview.identity.firstSeenAt) }}</div></div>
      <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.updatedAt') }}</div><div>{{ formatDate(overview.identity.updatedAt) }}</div></div>
    </CardContent>
  </Card>

  <Card>
    <CardHeader><CardTitle>{{ $t('settings.auctionTechnical.sections.fetchState') }}</CardTitle></CardHeader>
    <CardContent v-if="overview.fetchState" class="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
      <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.detailFetchedAt') }}</div><div>{{ formatDate(overview.fetchState.detailFetchedAt) }}</div></div>
      <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.llmFailures') }}</div><div>{{ overview.fetchState.llmFailures }}</div></div>
      <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.llmLastAttemptedAt') }}</div><div>{{ formatDate(overview.fetchState.llmLastAttemptedAt) }}</div></div>
      <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.llmBatchJob') }}</div><div>{{ overview.fetchState.llmBatchJob ?? '—' }}</div></div>
      <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.photoFailures') }}</div><div>{{ overview.fetchState.photoFailures }}</div></div>
      <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.photosCheckedAt') }}</div><div>{{ formatDate(overview.fetchState.photosCheckedAt) }}</div></div>
      <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.attachments') }}</div><div>{{ overview.fetchState.attachments.length }}</div></div>
    </CardContent>
    <CardContent v-else class="text-sm text-muted-foreground">{{ $t('settings.auctionTechnical.noData') }}</CardContent>
  </Card>
</template>
