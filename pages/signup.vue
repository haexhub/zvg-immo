<script setup lang="ts">
useSeoMeta({ robots: 'noindex, nofollow' })

const route = useRoute()
const router = useRouter()
const { signUp } = useAuth()

const email = ref('')
const password = ref('')
const error = ref('')
const pending = ref(false)
const done = ref(false)

function redirectTarget(): string {
  const target = route.query.redirect
  const raw = Array.isArray(target) ? target[0] : target
  return raw && raw.startsWith('/') ? raw : '/search'
}

async function onSubmit(): Promise<void> {
  error.value = ''
  pending.value = true
  const { error: signUpError } = await signUp(email.value, password.value)
  pending.value = false
  if (signUpError) {
    error.value = signUpError.message
    return
  }
  // Signup logs the user in immediately (GOTRUE_MAILER_AUTOCONFIRM=true in
  // Phase 1, no confirmation e-mail step — see docker-compose.yml).
  done.value = true
  router.push(redirectTarget())
}
</script>

<template>
  <main class="min-h-[calc(100vh-4rem)] flex items-center justify-center px-4">
    <form class="w-full max-w-sm space-y-4" @submit.prevent="onSubmit">
      <h1 class="text-2xl font-bold tracking-tight">{{ $t('auth.signup.title') }}</h1>
      <div class="space-y-1">
        <Label for="email">{{ $t('auth.email') }}</Label>
        <Input
          id="email"
          v-model="email"
          type="email"
          required
          autocomplete="email"
        />
      </div>
      <div class="space-y-1">
        <Label for="password">{{ $t('auth.password') }}</Label>
        <Input
          id="password"
          v-model="password"
          type="password"
          required
          minlength="6"
          autocomplete="new-password"
        />
      </div>
      <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
      <p v-if="done" class="text-sm text-emerald-600 dark:text-emerald-500">{{ $t('auth.signup.done') }}</p>
      <Button type="submit" :disabled="pending" class="w-full">
        {{ pending ? $t('auth.signup.submitting') : $t('auth.signup.submit') }}
      </Button>
      <p class="text-sm text-muted-foreground">
        {{ $t('auth.signup.hasAccount') }}
        <NuxtLink :to="`/login?redirect=${encodeURIComponent(redirectTarget())}`" class="text-primary hover:underline">{{ $t('auth.signup.loginLink') }}</NuxtLink>
      </p>
    </form>
  </main>
</template>
