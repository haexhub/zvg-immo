<script setup lang="ts">
const { user, signOut } = useAuth()
const route = useRoute()

function redirectQuery(): string {
  return `?redirect=${encodeURIComponent(route.fullPath)}`
}
</script>

<template>
  <div class="flex items-center gap-2 text-sm">
    <LocaleSwitcher />
    <CurrencySwitcher />
    <ThemeSwitcher />
    <template v-if="user">
      <span class="text-muted-foreground truncate max-w-40" :title="user.email">{{ user.email }}</span>
      <NuxtLink
        to="/account"
        class="h-9 inline-flex items-center rounded-md border bg-card px-3 shadow-xs hover:border-primary hover:text-primary transition-colors"
      >
        {{ $t('authStatus.myAccount') }}
      </NuxtLink>
      <button
        type="button"
        class="h-9 rounded-md border bg-card px-3 shadow-xs hover:border-primary hover:text-primary transition-colors"
        @click="signOut()"
      >
        {{ $t('authStatus.logout') }}
      </button>
    </template>
    <template v-else>
      <NuxtLink
        :to="`/login${redirectQuery()}`"
        class="h-9 inline-flex items-center rounded-md border bg-card px-3 shadow-xs hover:border-primary hover:text-primary transition-colors"
      >
        {{ $t('authStatus.login') }}
      </NuxtLink>
      <NuxtLink
        :to="`/signup${redirectQuery()}`"
        class="h-9 inline-flex items-center rounded-md bg-primary px-3 text-primary-foreground shadow-xs hover:opacity-90 transition-opacity"
      >
        {{ $t('authStatus.signup') }}
      </NuxtLink>
    </template>
  </div>
</template>
