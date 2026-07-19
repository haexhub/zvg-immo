<script setup lang="ts">
import { Gavel, Menu } from 'lucide-vue-next'
import { Button } from '~/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '~/components/ui/sheet'

const navItems = [
  { to: '/suche', labelKey: 'nav.search' },
  { to: '/#archiv', labelKey: 'nav.archive' },
  { to: '/#rechner', labelKey: 'nav.calculator' },
]

const mobileOpen = ref(false)
</script>

<template>
  <header class="sticky top-0 z-40 h-16 shrink-0 border-b bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60">
    <div class="h-full flex items-center gap-6 px-4">
      <NuxtLink to="/" class="flex items-center gap-2 font-bold tracking-tight shrink-0">
        <Gavel class="h-5 w-5 text-primary" />
        {{ $t('nav.brand') }}
      </NuxtLink>

      <nav class="hidden md:flex items-center gap-1">
        <Button v-for="item in navItems" :key="item.to" as-child variant="ghost" size="sm">
          <NuxtLink :to="item.to">{{ $t(item.labelKey) }}</NuxtLink>
        </Button>
      </nav>

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
          <nav class="flex flex-col gap-1 px-4">
            <Button
              v-for="item in navItems"
              :key="item.to"
              as-child
              variant="ghost"
              class="justify-start"
              @click="mobileOpen = false"
            >
              <NuxtLink :to="item.to">{{ $t(item.labelKey) }}</NuxtLink>
            </Button>
          </nav>
          <div class="mt-4 border-t px-4 pt-4">
            <AuthStatus class="flex-col items-stretch gap-2 [&>*]:justify-center" />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  </header>
</template>
