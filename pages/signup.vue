<script setup lang="ts">
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
  return raw && raw.startsWith('/') ? raw : '/'
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
  <main class="h-screen flex items-center justify-center px-4">
    <form class="w-full max-w-sm space-y-4" @submit.prevent="onSubmit">
      <h1 class="text-2xl font-bold tracking-tight">Registrieren</h1>
      <div class="space-y-1">
        <label class="text-sm font-medium" for="email">E-Mail</label>
        <input
          id="email"
          v-model="email"
          type="email"
          required
          autocomplete="email"
          class="w-full h-9 rounded-md border bg-card px-3 text-sm shadow-xs"
        />
      </div>
      <div class="space-y-1">
        <label class="text-sm font-medium" for="password">Passwort</label>
        <input
          id="password"
          v-model="password"
          type="password"
          required
          minlength="6"
          autocomplete="new-password"
          class="w-full h-9 rounded-md border bg-card px-3 text-sm shadow-xs"
        />
      </div>
      <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
      <p v-if="done" class="text-sm text-emerald-600 dark:text-emerald-500">Konto erstellt.</p>
      <button
        type="submit"
        :disabled="pending"
        class="w-full h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium shadow-xs hover:opacity-90 transition-opacity disabled:opacity-50"
      >
        {{ pending ? 'Registrieren …' : 'Registrieren' }}
      </button>
      <p class="text-sm text-muted-foreground">
        Bereits registriert?
        <NuxtLink :to="`/login?redirect=${encodeURIComponent(redirectTarget())}`" class="text-primary hover:underline">Anmelden</NuxtLink>
      </p>
    </form>
  </main>
</template>
