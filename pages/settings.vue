<script setup lang="ts">
import { ArrowLeft } from 'lucide-vue-next'
import { settingsSessionExpiredKey } from '~/composables/settings/useSettingsError'
import { useSettingsTaskOverview } from '~/composables/settings/useSettingsTaskOverview'

const { t } = useI18n()
const { stopProgressPolling } = useSettingsTaskOverview()

useHead({ title: t('settings.title') })

const authed = ref(false)
const passwordInput = ref('')
const authError = ref<string | null>(null)
const authPending = ref(false)
const adminLogoutError = ref<string | null>(null)

function clearAuthState(): void {
  authed.value = false
  stopProgressPolling()
}

provide(settingsSessionExpiredKey, clearAuthState)

async function probeSession(): Promise<void> {
  try {
    const res = await $fetch<{ authed: boolean }>('/api/settings/session', { cache: 'no-store' })
    authed.value = res.authed
  } catch {
    authed.value = false
  }
}

async function login(): Promise<void> {
  authError.value = null
  authPending.value = true
  try {
    await $fetch('/api/settings/login', {
      method: 'POST',
      body: { password: passwordInput.value },
    })
    passwordInput.value = ''
    authed.value = true
  } catch (err) {
    authError.value = (err as { statusMessage?: string; message?: string }).statusMessage ||
      (err as Error).message ||
      t('settings.login.error')
  } finally {
    authPending.value = false
  }
}

async function logout(): Promise<void> {
  adminLogoutError.value = null
  try {
    await $fetch('/api/settings/logout', { method: 'POST' })
    clearAuthState()
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 401) {
      clearAuthState()
      return
    }
    adminLogoutError.value = (err as { statusMessage?: string; message?: string }).statusMessage ||
      (err as Error).message ||
      t('settings.logoutAdminError')
  }
}

onMounted(probeSession)
</script>

<template>
  <main class="px-4 py-6">
    <div class="max-w-2xl mx-auto space-y-6">
      <div class="flex items-center justify-between gap-3">
        <NuxtLink to="/search" class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft class="h-4 w-4" /> {{ $t('settings.back') }}
        </NuxtLink>
        <div v-if="authed" class="flex items-center gap-2">
          <p v-if="adminLogoutError" class="text-sm text-destructive">{{ adminLogoutError }}</p>
          <Button type="button" variant="ghost" size="sm" @click="logout">{{ $t('settings.logoutAdmin') }}</Button>
        </div>
      </div>
      <h1 class="text-2xl font-bold tracking-tight">{{ $t('settings.heading') }}</h1>

      <Card v-if="!authed">
        <CardHeader>
          <CardTitle>{{ $t('settings.login.title') }}</CardTitle>
        </CardHeader>
        <CardContent class="space-y-4">
          <p class="text-sm text-muted-foreground">
            {{ $t('settings.login.protected') }}
          </p>
          <form class="space-y-3" @submit.prevent="login">
            <Input
              v-model="passwordInput"
              type="password"
              autocomplete="current-password"
              :placeholder="$t('settings.login.passwordPlaceholder')"
              :disabled="authPending"
            />
            <p v-if="authError" class="text-sm text-destructive">{{ authError }}</p>
            <Button type="submit" class="w-full" :disabled="authPending || !passwordInput">
              {{ authPending ? $t('settings.login.submitting') : $t('settings.login.submit') }}
            </Button>
          </form>
        </CardContent>
      </Card>

      <template v-else>
        <SettingsLawyersCard />
        <SettingsLlmConfigCard />
        <SettingsLlmProfilesCard />
        <SettingsLlmAssignmentsCard />
        <SettingsLlmBatchCard />
        <SettingsReprocessCard />
        <SettingsCountrySourcesCard />
        <SettingsExternalDataCard />
        <SettingsDisplayCard />

        <Card>
          <CardHeader>
            <CardTitle>{{ $t('settings.archive.title') }}</CardTitle>
          </CardHeader>
          <CardContent>
            <SettingsArchiveBrowser />
          </CardContent>
        </Card>
      </template>
    </div>
  </main>
</template>
