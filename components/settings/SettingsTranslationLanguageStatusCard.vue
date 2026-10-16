<script setup lang="ts">
import { Loader2, RefreshCw } from 'lucide-vue-next'
import type { ContentTargetLang } from '~/lib/content-language'
import type { StatusBucket, StatusCounts } from '~/composables/settings/useSettingsStatusOverview'
import type { StatusPieSegment } from './SettingsStatusPie.client.vue'
import SettingsStatusPie from './SettingsStatusPie.client.vue'

const props = defineProps<{
  country: string
  lang: ContentTargetLang
  counts: StatusCounts
  selected: StatusBucket | null
  actionPending: string | null
  segments: StatusPieSegment[]
}>()

const emit = defineEmits<{
  select: [bucket: string]
  retry: [bucket: 'open' | 'error']
}>()
</script>

<template>
  <section class="flex min-w-0 flex-col rounded-lg border bg-muted/15 p-4">
    <h3 class="mb-3 text-sm font-semibold">{{ $t('settings.translationStatus.titleForLang', { lang: props.lang.toUpperCase() }) }}</h3>
    <SettingsStatusPie :segments="props.segments" :selected="props.selected" :size="208" @select="emit('select', $event)" />
    <div class="mt-4 grid gap-2">
      <Button type="button" variant="outline" size="sm" :disabled="props.actionPending !== null || props.counts.open === 0" @click="emit('retry', 'open')">
        <Loader2 v-if="props.actionPending === `${props.country}:translation:${props.lang}:open`" class="h-4 w-4 animate-spin" />
        <RefreshCw v-else class="h-4 w-4" />
        {{ $t('settings.translationStatus.retryOpen') }}
      </Button>
      <Button type="button" variant="outline" size="sm" :disabled="props.actionPending !== null || props.counts.error === 0" @click="emit('retry', 'error')">
        <Loader2 v-if="props.actionPending === `${props.country}:translation:${props.lang}:error`" class="h-4 w-4 animate-spin" />
        <RefreshCw v-else class="h-4 w-4" />
        {{ $t('settings.translationStatus.retryFailed') }}
      </Button>
    </div>
  </section>
</template>
