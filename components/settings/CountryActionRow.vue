<script setup lang="ts">
// Shared row shell for the per-country lists in SettingsOsmImportCard and
// SettingsCountrySourcesCard — both rendered inside a
// `max-h-80 overflow-y-auto rounded-md border divide-y` container. Only the
// layout (leading slot, body, trailing action) is shared; each card keeps
// its own label/caption/toggle/button content, since the two lists carry
// meaningfully different status shapes (rowCount+requestedAt vs.
// enable-toggle+platform list+enrich status).
</script>

<template>
  <div class="flex items-start gap-3 px-3 py-2.5 hover:bg-muted/50">
    <slot name="leading" />
    <div class="min-w-0 flex-1">
      <slot />
    </div>
    <div class="shrink-0">
      <slot name="action" />
    </div>
  </div>
</template>
