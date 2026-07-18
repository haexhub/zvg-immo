<script setup lang="ts">
// Small login/account widget, embedded per-page since there's no shared
// layout (app.vue is just <NuxtPage>).

const { user, signOut } = useAuth()
const route = useRoute()

function redirectQuery(): string {
  return `?redirect=${encodeURIComponent(route.fullPath)}`
}
</script>

<template>
  <div class="flex items-center gap-2 text-sm">
    <template v-if="user">
      <span class="text-muted-foreground truncate max-w-40" :title="user.email">{{ user.email }}</span>
      <NuxtLink
        to="/account"
        class="h-9 inline-flex items-center rounded-md border bg-card px-3 shadow-xs hover:border-primary hover:text-primary transition-colors"
      >
        Mein Konto
      </NuxtLink>
      <button
        type="button"
        class="h-9 rounded-md border bg-card px-3 shadow-xs hover:border-primary hover:text-primary transition-colors"
        @click="signOut()"
      >
        Abmelden
      </button>
    </template>
    <template v-else>
      <NuxtLink
        :to="`/login${redirectQuery()}`"
        class="h-9 inline-flex items-center rounded-md border bg-card px-3 shadow-xs hover:border-primary hover:text-primary transition-colors"
      >
        Anmelden
      </NuxtLink>
      <NuxtLink
        :to="`/signup${redirectQuery()}`"
        class="h-9 inline-flex items-center rounded-md bg-primary px-3 text-primary-foreground shadow-xs hover:opacity-90 transition-opacity"
      >
        Registrieren
      </NuxtLink>
    </template>
  </div>
</template>
