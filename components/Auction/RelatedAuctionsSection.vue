<script setup lang="ts">
import type { RelatedAuction } from '~/server/utils/auction-relationships'
import { Link2 } from 'lucide-vue-next'

const props = defineProps<{ relatedAuctions: RelatedAuction[] }>()
const { t } = useI18n()

const groups = computed(() => {
  const byKind = new Map<RelatedAuction['kind'], RelatedAuction[]>()
  for (const auction of props.relatedAuctions) {
    const group = byKind.get(auction.kind)
    if (group) group.push(auction)
    else byKind.set(auction.kind, [auction])
  }
  return ([
    ['same_proceeding', byKind.get('same_proceeding') ?? []],
    ['same_address', byKind.get('same_address') ?? []],
  ] as const).filter(([, auctions]) => auctions.length > 0)
})

function detailPath(auction: RelatedAuction): string {
  return `/objekt/${encodeURIComponent(auction.platform)}/${encodeURIComponent(auction.externalId)}`
}

function dateLabel(auction: RelatedAuction): string | null {
  return auction.auctionDateText ?? auction.auctionDateIso
}
</script>

<template>
  <DetailSectionCard v-if="relatedAuctions.length" :title="t('objektDetail.relatedAuctionsTitle')">
    <div class="space-y-5">
      <section v-for="[kind, auctions] in groups" :key="kind">
        <h3 class="flex items-center gap-2 text-sm font-semibold">
          <Link2 class="h-4 w-4 text-primary" />
          {{ t(`objektDetail.relatedAuctions.${kind}.title`) }}
        </h3>
        <p class="mt-1 text-sm text-muted-foreground">
          {{ t(`objektDetail.relatedAuctions.${kind}.hint`) }}
        </p>
        <ul class="mt-3 space-y-2">
          <li v-for="auction in auctions" :key="`${auction.platform}:${auction.externalId}`">
            <NuxtLink
              :to="detailPath(auction)"
              class="block rounded-lg border border-border px-3 py-2 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <p class="font-medium leading-snug">{{ auction.address || auction.title || t('objektDetail.untitled') }}</p>
              <p class="mt-1 text-xs text-muted-foreground">
                {{ auction.authority }} · <span class="font-mono">{{ auction.caseNumber }}</span>
                <template v-if="dateLabel(auction)"> · {{ dateLabel(auction) }}</template>
              </p>
            </NuxtLink>
          </li>
        </ul>
      </section>
    </div>
  </DetailSectionCard>
</template>
