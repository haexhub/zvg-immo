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
  <Card>
    <CardHeader>
      <CardTitle class="text-base"><slot name="title">{{ title }}</slot></CardTitle>
      <CardDescription v-if="subtitle || $slots.subtitle">
        <slot name="subtitle">{{ subtitle }}</slot>
      </CardDescription>
      <CardAction v-if="$slots.action"><slot name="action" /></CardAction>
    </CardHeader>
    <CardContent>
      <slot />
    </CardContent>
  </Card>
</template>
