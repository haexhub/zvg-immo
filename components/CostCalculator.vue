<script setup lang="ts">
// Nebenkosten-/Kostenrechner für deutsche Zwangsversteigerungen (Phase 6 des
// SaaS-Plans, unabhängig von Auth/DB). Rein client-seitig — ruft nur die
// pure Funktion aus lib/auction-costs.ts auf.
import { BUNDESLAENDER, bundeslandFromRegion, calculateAuctionCosts, type Bundesland } from '~/lib/auction-costs'

const props = defineProps<{
  /** Startwert fürs Bargebot-Feld — der tatsächliche Verkehrswert der Auktion. */
  verkehrswertEur: number | null
  /** `Auction.region` — bei DE-Crawlern exakt der Bundesland-Name, dient als Default. */
  region: string
}>()

const bargebot = ref<number>(props.verkehrswertEur ?? 0)
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
  return n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })
}
</script>

<template>
  <section class="mb-8 space-y-3">
    <h2 class="text-base font-semibold">Nebenkostenrechner</h2>
    <p class="text-xs text-muted-foreground">
      Schätzung der Erwerbsnebenkosten für den Zuschlag — ersetzt keine steuerliche/rechtliche Beratung.
    </p>

    <div class="rounded-xl border bg-card p-5 space-y-5">
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div class="space-y-2">
          <label class="block text-sm font-medium" for="cost-calc-bargebot">Bargebot (€)</label>
          <input
            id="cost-calc-bargebot"
            v-model.number="bargebot"
            type="number"
            min="0"
            step="1000"
            class="h-9 w-full rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
        </div>

        <div class="space-y-2">
          <label class="block text-sm font-medium" for="cost-calc-bundesland">Bundesland</label>
          <select
            id="cost-calc-bundesland"
            v-model="bundesland"
            class="h-9 w-full rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option v-for="b in BUNDESLAENDER" :key="b" :value="b">{{ b }}</option>
          </select>
        </div>

        <div class="space-y-2">
          <label class="block text-sm font-medium" for="cost-calc-tage">Tage bis Zahlung</label>
          <input
            id="cost-calc-tage"
            v-model.number="tageBisZahlung"
            type="number"
            min="0"
            step="1"
            class="h-9 w-full rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
        </div>
      </div>

      <dl class="divide-y divide-border text-sm">
        <div v-for="item in result.items" :key="item.label" class="flex items-center justify-between gap-4 py-2">
          <div>
            <dt class="font-medium">{{ item.label }}</dt>
            <dd v-if="item.note" class="text-xs text-muted-foreground">{{ item.note }}</dd>
          </div>
          <dd class="tabular-nums font-medium shrink-0">{{ formatEur(item.amountEur) }}</dd>
        </div>
        <div class="flex items-center justify-between gap-4 py-2 font-semibold">
          <dt>Gesamt-Erwerbsnebenkosten</dt>
          <dd class="tabular-nums">{{ formatEur(result.nebenkostenGesamtEur) }}</dd>
        </div>
        <div class="flex items-center justify-between gap-4 py-2 text-base font-bold">
          <dt>Gesamtkosten (Bargebot + Nebenkosten)</dt>
          <dd class="tabular-nums">{{ formatEur(result.gesamtkostenEur) }}</dd>
        </div>
      </dl>

      <p class="text-xs text-muted-foreground">
        Kein Kaufvertrag nötig bei einer Zwangsversteigerung — daher entfallen Maklerprovision und Notarkosten,
        anders als beim freihändigen Kauf.
      </p>
    </div>
  </section>
</template>
