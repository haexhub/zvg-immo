<script setup lang="ts">
import type { AuctionDetail } from '~/server/api/auction/[platform]/[id].get'
import { useAuctionDetailFormatters } from '~/composables/useAuctionDetailFormatters'

const props = defineProps<{
  extraction: AuctionDetail['extraction'] | null
  defectsTranslating: boolean
  encumbrancesTranslating: boolean
  constructionTranslating: boolean
  locationCharacterTranslating: boolean
  planningNotesTranslating: boolean
  parcelsTranslating: boolean
}>()

const { formatArea, formatLandValue } = useAuctionDetailFormatters()

const planningNotesHasContent = computed(() => {
  const p = props.extraction?.planningNotes
  return !!p && (
    p.monumentProtection != null ||
    p.contamination != null ||
    p.developmentPlan != null ||
    p.landConsolidation != null ||
    p.developmentCharges != null ||
    p.redevelopmentArea != null ||
    p.conservationArea != null
  )
})

const defectItems = computed(() => props.extraction?.insights?.defects ?? [])
const encumbranceItems = computed(() => props.extraction?.insights?.encumbrances ?? [])
const landValueInsight = computed(() => props.extraction?.insights?.landValueEurPerSqm ?? null)
const constructionInsight = computed(() => props.extraction?.insights?.construction?.trim() ?? '')
const locationCharacterInsight = computed(() => props.extraction?.insights?.locationCharacter?.trim() ?? '')
const landParcelItems = computed(() => props.extraction?.planningNotes?.landParcels ?? [])
</script>

<template>
  <div class="space-y-6">
    <DetailSectionCard :title="$t('objektDetail.defectsTitle')">
      <template v-if="defectsTranslating" #action>
        <TranslationPendingBadge />
      </template>
      <ul v-if="defectItems.length" class="list-disc list-inside space-y-1 text-sm text-foreground/90">
        <li v-for="(defect, i) in defectItems" :key="i">{{ defect }}</li>
      </ul>
      <p v-else class="text-sm text-muted-foreground">{{ $t('objektDetail.noKnownDefects') }}</p>
    </DetailSectionCard>

    <DetailSectionCard :title="$t('objektDetail.encumbrancesTitle')">
      <template v-if="encumbrancesTranslating" #action>
        <TranslationPendingBadge />
      </template>
      <ul v-if="encumbranceItems.length" class="list-disc list-inside space-y-1 text-sm text-foreground/90">
        <li v-for="(encumbrance, i) in encumbranceItems" :key="i">{{ encumbrance }}</li>
      </ul>
      <p v-else class="text-sm text-muted-foreground">{{ $t('objektDetail.noKnownEncumbrances') }}</p>
    </DetailSectionCard>

    <DetailSectionCard :title="$t('objektDetail.landValueTitle')">
      <p v-if="landValueInsight != null" class="text-sm font-medium tabular-nums">{{ formatLandValue(landValueInsight) }}</p>
      <p v-else class="text-sm text-muted-foreground">{{ $t('objektDetail.noKnownLandValue') }}</p>
    </DetailSectionCard>

    <DetailSectionCard :title="$t('objektDetail.constructionTitle')">
      <template v-if="constructionTranslating" #action>
        <TranslationPendingBadge />
      </template>
      <p v-if="constructionInsight" class="whitespace-pre-line text-sm text-foreground/90 leading-relaxed">{{ constructionInsight }}</p>
      <p v-else class="text-sm text-muted-foreground">{{ $t('objektDetail.noKnownConstruction') }}</p>
    </DetailSectionCard>

    <DetailSectionCard :title="$t('objektDetail.neighborhoodCharacter')">
      <template v-if="locationCharacterTranslating" #action>
        <TranslationPendingBadge />
      </template>
      <p v-if="locationCharacterInsight" class="whitespace-pre-line text-sm text-foreground/90 leading-relaxed">{{ locationCharacterInsight }}</p>
      <p v-else class="text-sm text-muted-foreground">{{ $t('objektDetail.noKnownLocationCharacter') }}</p>
    </DetailSectionCard>

    <DetailSectionCard :title="$t('objektDetail.planningNotesTitle')">
      <template v-if="planningNotesTranslating" #action>
        <TranslationPendingBadge />
      </template>
      <dl v-if="planningNotesHasContent" class="space-y-2 text-sm">
        <div v-if="extraction?.planningNotes?.monumentProtection">
          <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.monumentProtection') }}</dt>
          <dd class="text-foreground/90">{{ extraction.planningNotes.monumentProtection }}</dd>
        </div>
        <div v-if="extraction?.planningNotes?.contamination">
          <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.contamination') }}</dt>
          <dd class="text-foreground/90">{{ extraction.planningNotes.contamination }}</dd>
        </div>
        <div v-if="extraction?.planningNotes?.developmentPlan">
          <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.developmentPlan') }}</dt>
          <dd class="text-foreground/90">{{ extraction.planningNotes.developmentPlan }}</dd>
        </div>
        <div v-if="extraction?.planningNotes?.landConsolidation">
          <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.landConsolidation') }}</dt>
          <dd class="text-foreground/90">{{ extraction.planningNotes.landConsolidation }}</dd>
        </div>
        <div v-if="extraction?.planningNotes?.developmentCharges">
          <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.developmentCharges') }}</dt>
          <dd class="text-foreground/90">{{ extraction.planningNotes.developmentCharges }}</dd>
        </div>
        <div v-if="extraction?.planningNotes?.redevelopmentArea">
          <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.redevelopmentArea') }}</dt>
          <dd class="text-foreground/90">{{ extraction.planningNotes.redevelopmentArea }}</dd>
        </div>
        <div v-if="extraction?.planningNotes?.conservationArea">
          <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.conservationArea') }}</dt>
          <dd class="text-foreground/90">{{ extraction.planningNotes.conservationArea }}</dd>
        </div>
      </dl>
      <p v-else class="text-sm text-muted-foreground">{{ $t('objektDetail.noKnownPlanningNotes') }}</p>
    </DetailSectionCard>

    <DetailSectionCard :title="$t('objektDetail.parcelsTitle')">
      <template v-if="parcelsTranslating" #action>
        <TranslationPendingBadge />
      </template>
      <ul v-if="landParcelItems.length" class="space-y-2 text-sm">
        <li v-for="(parcel, i) in landParcelItems" :key="i" class="flex items-baseline justify-between gap-3">
          <span class="font-medium">{{ parcel.label }}</span>
          <span class="text-foreground/90 text-right">
            <span v-if="parcel.areaSqm != null" class="tabular-nums">{{ formatArea(parcel.areaSqm) }}</span>
            <span v-if="parcel.use" class="block text-xs text-muted-foreground">{{ parcel.use }}</span>
          </span>
        </li>
      </ul>
      <p v-else class="text-sm text-muted-foreground">{{ $t('objektDetail.noKnownParcels') }}</p>
    </DetailSectionCard>
  </div>
</template>
