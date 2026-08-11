<script setup lang="ts">
import { ArrowLeft } from 'lucide-vue-next'
import { settingsSessionExpiredKey, useSettingsError } from '~/composables/settings/useSettingsError'
import { useSettingsTaskOverview } from '~/composables/settings/useSettingsTaskOverview'

const { t } = useI18n()

useHead({ title: t('settings.title') })
useSeoMeta({ robots: 'noindex, nofollow' })

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

const { normalizeSettingsError } = useSettingsError()
const { stopProgressPolling } = useSettingsTaskOverview()

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
    const e = typeof err === 'object' && err !== null
      ? err as { data?: { statusMessage?: string }; statusMessage?: string; message?: string }
      : {}
    authError.value = e.data?.statusMessage || e.statusMessage || e.message || t('settings.login.error')
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
    adminLogoutError.value = normalizeSettingsError(err, t('settings.logoutAdminError'))
  }
}

onMounted(probeSession)
</script>

<template>
  <main class="px-4 py-6">
    <div class="mx-auto max-w-6xl space-y-6">
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

      <Card v-if="!authed" class="mx-auto max-w-2xl">
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
        <SettingsCountryStatusOverview />

        <section class="space-y-4">
          <h2 class="text-lg font-semibold text-muted-foreground">{{ $t('settings.sections.pipeline') }}</h2>
          <SettingsGeoMetricsCard />
          <SettingsExternalDataCard />
          <SettingsReprocessCard />
        </section>

        <section class="space-y-4">
          <h2 class="text-lg font-semibold text-muted-foreground">{{ $t('settings.sections.llm') }}</h2>
          <SettingsLlmKillSwitchCard />
          <SettingsLlmConfigCard />
          <SettingsLlmProfilesCard />
          <SettingsLlmAssignmentsCard />
          <SettingsLlmBatchCard />
          <SettingsLlmCostCard />
        </section>

        <section class="space-y-4">
          <h2 class="text-lg font-semibold text-muted-foreground">{{ $t('settings.sections.admin') }}</h2>
          <SettingsLawyersCard />
          <SettingsOutboundDeliveriesCard />
          <SettingsDisplayCard />

          <Card>
            <CardHeader>
              <CardTitle>{{ $t('settings.archive.title') }}</CardTitle>
            </CardHeader>
            <CardContent>
              <SettingsArchiveBrowser />
            </CardContent>
          </Card>
        </section>
      </template>
    </div>
  </main>
</template>
