<script setup lang="ts">
// Nebenkosten-/Kostenrechner für deutsche Zwangsversteigerungen — lebt in der
// Sidebar der Objekt-Detailseite (ersetzt die frühere zusätzliche,
// nicht-interaktive "Erwerbsgebühren"-Card, die dieselbe Kostenaufstellung
// nur mit fixen Annahmen zeigte). Rein client-seitig — ruft nur die pure
// Funktion aus lib/auction-costs.ts auf.
import { BUNDESLAENDER, bundeslandFromRegion, calculateAuctionCosts, formatEur as formatEurWithLocale, type Bundesland } from '~/lib/auction-costs'

const props = defineProps<{
  /** Startwert fürs Bargebot-Feld — der tatsächliche Verkehrswert der Auktion. */
  marketValueEur: number | null
  /** `Auction.region` — bei DE-Crawlern exakt der Bundesland-Name, dient als Default. */
  region?: string | null
}>()

const { t } = useI18n()
const intlLocale = useIntlLocale()

const bargebot = ref<number>(props.marketValueEur ?? 0)
const bundesland = ref<Bundesland>(bundeslandFromRegion(props.region) ?? 'Nordrhein-Westfalen')
const tageBisZahlung = ref<number>(30)

const result = computed(() =>
  calculateAuctionCosts({
    bargebot: bargebot.value || 0,
    bundesland: bundesland.value,
    tageBisZahlung: tageBisZahlung.value || 0,
  }),
)

function formatEur(n: number): string {
  return formatEurWithLocale(n, intlLocale.value)
}
</script>

<template>
  <DetailSectionCard :title="t('costCalculator.title')" :subtitle="t('costCalculator.intro')">
    <div class="space-y-4">
      <div class="space-y-2">
        <Label for="cost-calc-bargebot">{{ t('costCalculator.bargebot') }}</Label>
        <Input
          id="cost-calc-bargebot"
          v-model.number="bargebot"
          type="number"
          min="0"
          step="1000"
        />
      </div>

      <div class="space-y-2">
        <Label for="cost-calc-bundesland">{{ t('costCalculator.bundesland') }}</Label>
        <Select v-model="bundesland">
          <SelectTrigger id="cost-calc-bundesland" class="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="b in BUNDESLAENDER" :key="b" :value="b">{{ b }}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="space-y-2">
        <Label for="cost-calc-tage">{{ t('costCalculator.daysUntilPayment') }}</Label>
        <Input
          id="cost-calc-tage"
          v-model.number="tageBisZahlung"
          type="number"
          min="0"
          step="1"
        />
      </div>
    </div>

    <dl class="mt-5 divide-y divide-border text-sm">
      <div v-for="item in result.items" :key="item.label" class="flex items-center justify-between gap-4 py-2">
        <div>
          <dt class="font-medium">{{ item.label }}</dt>
          <dd v-if="item.note" class="text-xs text-muted-foreground">{{ item.note }}</dd>
        </div>
        <dd class="tabular-nums font-medium shrink-0">{{ formatEur(item.amountEur) }}</dd>
      </div>
      <div class="flex items-center justify-between gap-4 py-2 font-semibold">
        <dt>{{ t('costCalculator.totalAncillaryCosts') }}</dt>
        <dd class="tabular-nums">{{ formatEur(result.nebenkostenGesamtEur) }}</dd>
      </div>
      <div class="flex items-center justify-between gap-4 py-2 text-base font-bold">
        <dt>{{ t('costCalculator.totalCosts') }}</dt>
        <dd class="tabular-nums">{{ formatEur(result.gesamtkostenEur) }}</dd>
      </div>
    </dl>

    <p class="mt-4 text-xs text-muted-foreground">
      {{ t('costCalculator.disclaimer') }}
    </p>
  </DetailSectionCard>
</template>
