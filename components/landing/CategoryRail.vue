<script setup lang="ts">
defineProps<{
  title: string
  subtitle?: string
}>()
</script>

<template>
  <section class="py-6">
    <div class="mb-3 px-1">
      <h2 class="text-xl font-semibold tracking-tight sm:text-2xl">{{ title }}</h2>
      <p v-if="subtitle" class="text-sm text-muted-foreground">{{ subtitle }}</p>
    </div>
    <div class="flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-px-1 pb-2">
      <slot />
    </div>
  </section>
</template>
