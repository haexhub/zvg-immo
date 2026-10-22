<script setup lang="ts">
defineProps<{
  active: boolean
  hint: string | null
  toggleClass: string
}>()

defineEmits<{ toggle: [] }>()

const { t } = useI18n()
</script>

<template>
  <div class="flex flex-col items-start gap-1">
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
    >{{ active ? hint : '' }}</p>
  </div>
</template>
