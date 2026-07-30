<script setup lang="ts">
// Single card shell for every section on the Objekt-Detailseite
// (pages/objekt/[platform]/[id].vue and its child components) — title always
// lives inside the card via CardHeader/CardTitle, never floating above it,
// so sections read as one consistent layout instead of a mix of
// title-above-card and title-inside-card patterns.
defineProps<{
  title?: string
  subtitle?: string
}>()
</script>

<template>
  <Card class="detail-section-card gap-5">
    <CardHeader>
      <CardTitle class="text-xl font-semibold leading-tight md:text-2xl"><slot name="title">{{ title }}</slot></CardTitle>
      <CardDescription v-if="subtitle || $slots.subtitle" class="text-sm leading-relaxed text-foreground/80 md:text-base">
        <slot name="subtitle">{{ subtitle }}</slot>
      </CardDescription>
      <CardAction v-if="$slots.action"><slot name="action" /></CardAction>
    </CardHeader>
    <CardContent class="text-base leading-relaxed text-card-foreground md:text-lg">
      <slot />
    </CardContent>
  </Card>
</template>
