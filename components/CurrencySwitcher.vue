<script setup lang="ts">
const { currency, setPreferredCurrency, availableCurrencies } = useCurrencyDisplay()
</script>

<template>
  <select
    :value="currency"
    class="h-9 rounded-md border bg-card px-2 text-sm shadow-xs hover:border-primary transition-colors"
    :aria-label="$t('currencySwitcher.label')"
    @change="setPreferredCurrency(($event.target as HTMLSelectElement).value)"
  >
    <option v-for="c in availableCurrencies" :key="c" :value="c">{{ c }}</option>
  </select>
</template>
