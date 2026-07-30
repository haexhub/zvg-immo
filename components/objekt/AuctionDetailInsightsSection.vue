<script setup lang="ts">
import type { Component } from 'vue'
import type { UsageIdea, UsageIdeaType } from '~/lib/usage-idea'
import type { RenovationCostCategory, RenovationCostItem } from '~/lib/renovation-cost'
import type { AuctionDetail } from '~/server/api/auction/[platform]/[id].get'
import { useAuctionDetailFormatters } from '~/composables/useAuctionDetailFormatters'
import {
  BrickWall,
  Bath,
  Blinds,
  Heater,
  Home,
  Layers3,
  Lightbulb,
  Loader2,
  Sprout,
  SquareStack,
  Tractor,
  TreePine,
  Warehouse,
  Waves,
  Wrench,
  Zap,
} from 'lucide-vue-next'

const props = defineProps<{
  extraction: AuctionDetail['extraction'] | null
  defectsTranslating: boolean
  encumbrancesTranslating: boolean
  constructionTranslating: boolean
  locationCharacterTranslating: boolean
  planningNotesTranslating: boolean
  parcelsTranslating: boolean
  usageIdeas: UsageIdea[] | null
  usageIdeasPending: boolean
  usageIdeasError: string | null
  renovationCost: RenovationCostItem[] | null
  renovationCostPending: boolean
  renovationCostError: string | null
}>()

const emit = defineEmits<{
  generateUsageIdeas: []
  generateRenovationCost: []
}>()

const usageIdeaTypeLabel = useUsageIdeaTypeLabel()
const renovationCostCategoryLabel = useRenovationCostCategoryLabel()
const { formatArea, formatLandValue, formatCostRange } = useAuctionDetailFormatters()

const USAGE_IDEA_ICONS: Partial<Record<UsageIdeaType, Component>> = {
  'owner-occupation': Home,
  'owner-occupation-with-sublet': Layers3,
  'vacation-rental': Waves,
  farm: Tractor,
  agricultural: Sprout,
  forestry: TreePine,
  warehouse: Warehouse,
  other: Lightbulb,
}

const RENOVATION_COST_ICONS: Partial<Record<RenovationCostCategory, Component>> = {
  roof: Home,
  'facade-insulation': BrickWall,
  windows: Blinds,
  heating: Heater,
  electrical: Zap,
  'plumbing-bathroom': Bath,
  flooring: SquareStack,
  other: Wrench,
}

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

    <DetailSectionCard :title="$t('objektDetail.usageIdeasTitle')">
      <ul v-if="usageIdeas?.length" class="space-y-3 text-sm">
        <li v-for="(idea, i) in usageIdeas" :key="i" class="flex items-start gap-3">
          <component :is="USAGE_IDEA_ICONS[idea.type] ?? Lightbulb" class="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div class="min-w-0">
            <p class="font-medium leading-snug">{{ usageIdeaTypeLabel(idea.type, idea.label) }}</p>
            <p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">{{ idea.rationale }}</p>
          </div>
        </li>
      </ul>
      <div v-else-if="usageIdeasError" class="flex items-center gap-2">
        <p class="text-sm text-destructive">{{ usageIdeasError }}</p>
        <Button type="button" size="sm" variant="outline" @click="emit('generateUsageIdeas')">
          {{ $t('objektDetail.usageIdeasRetry') }}
        </Button>
      </div>
      <div
        v-else-if="usageIdeasPending"
        class="inline-flex items-center gap-1.5 text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        <Loader2 class="h-3.5 w-3.5 animate-spin text-primary" aria-hidden="true" />
        <span>{{ $t('objektDetail.usageIdeasPending') }}</span>
      </div>
      <Button v-else type="button" size="sm" variant="outline" @click="emit('generateUsageIdeas')">
        {{ $t('objektDetail.usageIdeasGenerate') }}
      </Button>
    </DetailSectionCard>

    <DetailSectionCard :title="$t('objektDetail.renovationCostTitle')">
      <ul v-if="renovationCost?.length" class="space-y-3 text-sm">
        <li v-for="(item, i) in renovationCost" :key="i" class="flex items-start gap-3">
          <component :is="RENOVATION_COST_ICONS[item.category] ?? Wrench" class="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline justify-between gap-3">
              <p class="font-medium leading-snug">{{ renovationCostCategoryLabel(item.category, item.label) }}</p>
              <span class="shrink-0 text-xs font-medium tabular-nums text-foreground/90">
                {{ formatCostRange(item.costMinEur, item.costMaxEur) }}
              </span>
            </div>
            <p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {{ item.rationale }}
              <span v-if="item.confidence">
                ({{ item.confidence === 'high' ? $t('objektDetail.confidenceHigh') : $t('objektDetail.confidenceLow') }})
              </span>
            </p>
          </div>
        </li>
      </ul>
      <p v-else-if="renovationCost" class="text-sm text-muted-foreground">
        {{ $t('objektDetail.renovationCostEmpty') }}
      </p>
      <div v-else-if="renovationCostError" class="flex items-center gap-2">
        <p class="text-sm text-destructive">{{ renovationCostError }}</p>
        <Button type="button" size="sm" variant="outline" @click="emit('generateRenovationCost')">
          {{ $t('objektDetail.renovationCostRetry') }}
        </Button>
      </div>
      <div
        v-else-if="renovationCostPending"
        class="inline-flex items-center gap-1.5 text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        <Loader2 class="h-3.5 w-3.5 animate-spin text-primary" aria-hidden="true" />
        <span>{{ $t('objektDetail.renovationCostPending') }}</span>
      </div>
      <Button v-else type="button" size="sm" variant="outline" @click="emit('generateRenovationCost')">
        {{ $t('objektDetail.renovationCostGenerate') }}
      </Button>
    </DetailSectionCard>
  </div>
</template>
