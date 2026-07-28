<script setup lang="ts">
import { Loader2 } from 'lucide-vue-next'

const { t } = useI18n()
</script>

<template>
  <div
    class="inline-flex items-center gap-1.5 rounded-md border border-primary/20 bg-primary/5 px-2 py-1 text-xs font-medium text-muted-foreground"
    role="status"
    aria-live="polite"
  >
    <Loader2 class="h-3.5 w-3.5 animate-spin text-primary" aria-hidden="true" />
    <span>{{ t('objektDetail.translationPendingHint') }}</span>
  </div>
</template>
