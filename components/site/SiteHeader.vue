<script setup lang="ts">
import { Menu } from 'lucide-vue-next'

const mobileOpen = ref(false)
</script>

<template>
  <header class="sticky top-0 z-40 shrink-0 border-b bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60">
    <div class="h-16 flex items-center gap-4 px-4">
      <NuxtLink to="/" class="flex items-center gap-2 font-bold tracking-tight shrink-0">
        <SitePropHammerLogo class="h-8 w-8 text-amber-500" />
        {{ $t('nav.brand') }}
      </NuxtLink>

      <!-- Teleport target: the landing hero's search bar slides in here once
           it scrolls out from under this header (see pages/index.vue).
           Empty otherwise, so it has no footprint on other pages. -->
      <div id="header-search-target" class="min-w-0 flex-1" />

      <AuthStatus class="ml-auto hidden md:flex" />

      <Sheet v-model:open="mobileOpen">
        <SheetTrigger as-child class="ml-auto md:hidden">
          <Button variant="ghost" size="icon" :aria-label="$t('nav.menu')">
            <Menu class="h-5 w-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="right" class="w-72">
          <SheetHeader>
            <SheetTitle>{{ $t('nav.brand') }}</SheetTitle>
          </SheetHeader>
          <div class="px-4 pt-4">
            <AuthStatus class="flex-col items-stretch gap-2 *:justify-center" />
          </div>
        </SheetContent>
      </Sheet>
    </div>

    <div v-if="$slots.search" class="border-t px-4 py-2">
      <slot name="search" />
    </div>
  </header>
</template>
