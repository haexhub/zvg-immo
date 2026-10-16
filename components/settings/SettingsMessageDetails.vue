<script setup lang="ts">
const props = defineProps<{
  text: string
  variant?: 'error' | 'warning' | 'muted'
  role?: string
}>()

const COLLAPSE_LENGTH = 200

const expanded = ref(false)

const entries = computed(() => props.text.split('; ').filter(Boolean))
const isLong = computed(() => props.text.length > COLLAPSE_LENGTH)
const summary = computed(() => (
  isLong.value ? `${props.text.slice(0, 140).trimEnd()}…` : props.text
))
const detailText = computed(() => entries.value.join('\n'))

const colorClass = computed(() => {
  if (props.variant === 'error') return 'text-destructive'
  if (props.variant === 'muted') return 'text-muted-foreground'
  return 'text-amber-600 dark:text-amber-400'
})
</script>

<template>
  <div class="space-y-1.5">
    <div class="flex items-start justify-between gap-2">
      <p :role="role" class="text-sm break-words" :class="colorClass">{{ summary }}</p>
      <Button
        v-if="isLong"
        type="button"
        variant="ghost"
        size="sm"
        class="h-6 shrink-0 px-2 text-xs"
        @click="expanded = !expanded"
      >
        {{ expanded ? $t('settings.messageDetails.hide') : $t('settings.messageDetails.show', { count: entries.length }) }}
      </Button>
    </div>
    <textarea
      v-if="isLong && expanded"
      readonly
      :value="detailText"
      class="h-48 w-full resize-none overflow-y-auto rounded-md border bg-muted/30 p-2 font-mono text-xs"
    />
  </div>
</template>
