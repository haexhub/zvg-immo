<script setup lang="ts">
// Visual placeholder for detail-page sections whose underlying data doesn't
// exist yet (Grundbuch, Flurstücke, Orte in der Nähe — no extraction source
// for these today; Mängel/Belastungen/Bodenrichtwert/Bau & Instandhaltung/
// Lage now come from a.extraction.insights and render as real cards instead).
// Renders skeleton bars instead of the real section content — never
// fabricated text — behind a lock overlay, so the layout previews a future
// premium tier without claiming data we don't have. No subscription/payment
// system backs the CTA; it links to signup.
import { Crown } from 'lucide-vue-next'

withDefaults(defineProps<{
  /** Number of skeleton rows to render behind the overlay. */
  rows?: number
}>(), {
  rows: 3,
})

const { t } = useI18n()
</script>

<template>
  <div class="relative min-h-32 overflow-hidden rounded-lg">
    <div class="space-y-2.5 select-none opacity-60" aria-hidden="true">
      <div v-for="i in rows" :key="i" class="h-3 rounded bg-muted-foreground/20" :style="{ width: `${85 - (i % 3) * 15}%` }" />
    </div>
    <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/70 backdrop-blur-[2px] text-center px-4">
      <Crown class="h-5 w-5 text-amber-500" />
      <p class="text-sm font-semibold">{{ t('premiumLock.label') }}</p>
      <NuxtLink
        to="/signup"
        class="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
      >
        {{ t('premiumLock.cta') }}
      </NuxtLink>
    </div>
  </div>
</template>
