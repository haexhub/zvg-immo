<script setup lang="ts">
const route = useRoute()
const router = useRouter()
const { signIn } = useAuth()

const email = ref('')
const password = ref('')
const error = ref('')
const pending = ref(false)

function redirectTarget(): string {
  const target = route.query.redirect
  const raw = Array.isArray(target) ? target[0] : target
  return raw && raw.startsWith('/') ? raw : '/search'
}

async function onSubmit(): Promise<void> {
  error.value = ''
  pending.value = true
  const { error: signInError } = await signIn(email.value, password.value)
  pending.value = false
  if (signInError) {
    error.value = signInError.message
    return
  }
  router.push(redirectTarget())
}
</script>

<template>
  <main class="min-h-[calc(100vh-4rem)] flex items-center justify-center px-4">
    <form class="w-full max-w-sm space-y-4" @submit.prevent="onSubmit">
      <h1 class="text-2xl font-bold tracking-tight">{{ $t('auth.login.title') }}</h1>
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
          autocomplete="current-password"
        />
      </div>
      <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
      <Button type="submit" :disabled="pending" class="w-full">
        {{ pending ? $t('auth.login.submitting') : $t('auth.login.submit') }}
      </Button>
      <p class="text-sm text-muted-foreground">
        {{ $t('auth.login.noAccount') }}
        <NuxtLink :to="`/signup?redirect=${encodeURIComponent(redirectTarget())}`" class="text-primary hover:underline">{{ $t('auth.login.signupLink') }}</NuxtLink>
      </p>
    </form>
  </main>
</template>
