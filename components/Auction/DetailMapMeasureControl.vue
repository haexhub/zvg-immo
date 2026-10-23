<script setup lang="ts">
defineProps<{
  active: boolean
  hint: string | null
  distance: string | null
  measurements: { id: number; label: string }[]
  toggleClass: string
}>()

defineEmits<{ toggle: [], remove: [id: number] }>()

const { t } = useI18n()
</script>

<template>
  <div class="flex flex-col items-end gap-1">
    <button
      type="button"
      :class="[toggleClass, active && 'border-blue-600 text-blue-700 ring-1 ring-blue-600']"
      :aria-pressed="active"
      @click="$emit('toggle')"
    >
      {{ t('map.measureDistance') }}
    </button>
    <p
      aria-live="polite"
      class="empty:hidden max-w-56 rounded-md bg-white/95 px-2 py-1 text-xs text-gray-900 shadow-sm"
    >
      <template v-if="active">
        <span>{{ hint }}</span>
        <span v-if="distance" class="block">{{ distance }}</span>
      </template>
    </p>
    <!-- The floating "×" on the map only exists while hovering, which a
         keyboard can't do: this list is the same action as real buttons.
         Hidden until something inside it has focus, so it costs no map space. -->
    <ul
      v-if="measurements.length"
      :aria-label="t('map.measureListLabel')"
      class="sr-only focus-within:not-sr-only flex max-w-56 flex-col gap-1 rounded-md bg-white/95 p-1 text-xs text-gray-900 shadow-sm"
    >
      <li v-for="measurement in measurements" :key="measurement.id" class="flex items-center justify-between gap-2 px-1">
        <span>{{ measurement.label }}</span>
        <button
          type="button"
          :aria-label="`${t('map.measureRemove')}: ${measurement.label}`"
          class="flex size-5 cursor-pointer items-center justify-center rounded-full border border-slate-900/20 bg-white font-bold leading-none text-red-600 hover:bg-red-50"
          @click="$emit('remove', measurement.id)"
        >
          ×
        </button>
      </li>
    </ul>
  </div>
</template>
