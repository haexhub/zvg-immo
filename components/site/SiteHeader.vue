<script setup lang="ts">
import { Menu } from 'lucide-vue-next'

const mobileOpen = ref(false)

// Airbnb-style collapsing header: brand row plus a search row that hosts the
// large SearchBar (filled via the #search slot by layouts/landing.vue and
// layouts/search.vue). Scrolling down shrinks both rows, and the bar itself
// drops to its compact 3-button form — see useHeaderCompact.
const compact = useHeaderCompact()
const headerRef = ref<HTMLElement>()

// The scroll container differs per surface: the landing page scrolls the
// window, /search scrolls its results pane inside a fixed-height layout.
// Scroll events don't bubble but they do capture, so a single document-level
// capturing listener sees both — no page has to report its scroll position.
const COMPACT_FROM = 32
function handleScroll(event: Event): void {
  const target = event.target
  // Scrolling inside a search popover (or the menu sheet) must not collapse
  // the header out from under the user.
  if (target instanceof Node && headerRef.value?.contains(target)) return
  if (target === document || target === window) {
    compact.value = window.scrollY > COMPACT_FROM
    return
  }
  if (!(target instanceof HTMLElement)) return
  // The landing rails scroll horizontally — their scrollTop stays 0 and would
  // otherwise re-expand the header halfway down the page.
  if (target.scrollHeight <= target.clientHeight) return
  compact.value = target.scrollTop > COMPACT_FROM
}

onMounted(() => {
  // Covers a back-navigation into an already scrolled page.
  compact.value = window.scrollY > COMPACT_FROM
  document.addEventListener('scroll', handleScroll, { capture: true, passive: true })
})
onBeforeUnmount(() => {
  document.removeEventListener('scroll', handleScroll, { capture: true })
  compact.value = false
})
</script>

<template>
  <header
    ref="headerRef"
    class="sticky top-0 z-40 shrink-0 border-b bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60"
  >
    <div
      class="flex items-center gap-4 px-4 transition-[height] duration-200"
      :class="compact ? 'h-14' : 'h-16'"
    >
      <NuxtLink to="/" class="flex items-center gap-2 font-bold tracking-tight shrink-0">
        <SiteImmoHammerLogo
          class="text-amber-500 transition-all duration-200"
          :class="compact ? 'h-7 w-7' : 'h-8 w-8'"
        />
        {{ $t('nav.brand') }}
      </NuxtLink>

      <Sheet v-model:open="mobileOpen">
        <SheetTrigger as-child class="ml-auto">
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

    <div
      v-if="$slots.search"
      class="px-4 transition-[padding] duration-200"
      :class="compact ? 'pb-3' : 'pb-6'"
    >
      <slot name="search" />
    </div>
  </header>
</template>
