<script setup lang="ts">
import { ExternalLink, Loader2 } from 'lucide-vue-next'
import { useSettingsError } from '~/composables/settings/useSettingsError'
import type { ClaudeSetupStatus } from '~/server/api/settings/claude/status.get'

const { t } = useI18n()
const { normalizeSettingsError } = useSettingsError()

const status = ref<ClaudeSetupStatus | null>(null)
const codeInput = ref('')
const actionPending = ref(false)
const claudeError = ref<string | null>(null)
const isActiveFlow = computed(() =>
  !!status.value && ['awaiting-url', 'awaiting-code', 'finishing'].includes(status.value.state),
)
let pollTimer: ReturnType<typeof setInterval> | null = null

async function refreshStatus(): Promise<void> {
  try {
    status.value = await $fetch<ClaudeSetupStatus>('/api/settings/claude/status', { cache: 'no-store' })
    claudeError.value = null
  } catch (err) {
    claudeError.value = normalizeSettingsError(err, t('settings.claude.statusUnreachable'))
  }
}

async function startLogin(): Promise<void> {
  claudeError.value = null
  actionPending.value = true
  try {
    await $fetch('/api/settings/claude/login', { method: 'POST' })
    await refreshStatus()
  } catch (err) {
    claudeError.value = normalizeSettingsError(err, t('settings.claude.loginStartFailed'))
  } finally {
    actionPending.value = false
  }
}

async function submitCode(): Promise<void> {
  if (!codeInput.value.trim()) return
  claudeError.value = null
  actionPending.value = true
  try {
    await $fetch('/api/settings/claude/code', {
      method: 'POST',
      body: { code: codeInput.value.trim() },
    })
    codeInput.value = ''
    await refreshStatus()
  } catch (err) {
    claudeError.value = normalizeSettingsError(err, t('settings.claude.codeSubmitFailed'))
  } finally {
    actionPending.value = false
  }
}

async function resetFlow(): Promise<void> {
  claudeError.value = null
  actionPending.value = true
  try {
    await $fetch('/api/settings/claude/reset', { method: 'POST' })
    codeInput.value = ''
    await refreshStatus()
  } catch (err) {
    claudeError.value = normalizeSettingsError(err, t('settings.claude.resetFailed'))
  } finally {
    actionPending.value = false
  }
}

async function claudeLogout(): Promise<void> {
  claudeError.value = null
  actionPending.value = true
  try {
    await $fetch('/api/settings/claude/logout', { method: 'POST' })
    codeInput.value = ''
    await refreshStatus()
  } catch (err) {
    claudeError.value = normalizeSettingsError(err, t('settings.claude.logoutError'))
  } finally {
    actionPending.value = false
  }
}

function startPolling(): void {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    if (!isActiveFlow.value) {
      stopPolling()
      return
    }
    void refreshStatus()
  }, 2000)
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

watch(isActiveFlow, (active) => {
  if (active) startPolling()
  else stopPolling()
})

onMounted(refreshStatus)
onBeforeUnmount(stopPolling)
</script>

<template>
  <div class="border-t pt-4 space-y-4">
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-semibold">{{ $t('settings.claude.title') }}</h3>
      <Button v-if="status?.credentialsExist" type="button" variant="ghost" size="sm" :disabled="actionPending" @click="claudeLogout">
        {{ $t('settings.claude.logout') }}
      </Button>
    </div>
    <p class="text-sm text-muted-foreground">
      {{ $t('settings.claude.description') }}
    </p>

    <p v-if="!status" class="text-sm text-muted-foreground">{{ $t('settings.claude.loadingStatus') }}</p>

    <template v-else>
      <div v-if="status.state === 'idle' && !status.credentialsExist" class="space-y-3">
        <p class="text-sm">{{ $t('settings.claude.statusLabel') }} <span class="font-medium">{{ $t('settings.claude.notConnected') }}</span></p>
        <Button type="button" :disabled="actionPending" @click="startLogin">
          {{ actionPending ? $t('settings.claude.starting') : $t('settings.claude.startLogin') }}
        </Button>
      </div>

      <div v-else-if="status.state === 'idle' && status.credentialsExist" class="space-y-3">
        <p class="text-sm text-emerald-600 dark:text-emerald-500">{{ $t('settings.claude.connected') }}</p>
        <div class="flex flex-wrap gap-2">
          <Button type="button" variant="outline" :disabled="actionPending" @click="startLogin">{{ $t('settings.claude.reconnect') }}</Button>
        </div>
      </div>

      <div v-else-if="status.state === 'awaiting-url'" class="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 class="h-4 w-4 animate-spin" />
        {{ $t('settings.claude.openingLogin') }}
      </div>

      <div v-else-if="status.state === 'awaiting-code'" class="space-y-4">
        <div>
          <p class="text-sm mb-2">{{ $t('settings.claude.step1') }}</p>
          <Button v-if="status.oauthUrl" as-child variant="outline" size="sm">
            <a :href="status.oauthUrl" target="_blank" rel="noopener">
              <ExternalLink class="h-4 w-4" />
              {{ $t('settings.claude.openOauth') }}
            </a>
          </Button>
        </div>
        <div>
          <p class="text-sm mb-2">{{ $t('settings.claude.step2') }}</p>
          <Textarea v-model="codeInput" rows="2" :placeholder="$t('settings.claude.codePlaceholder')" class="font-mono" :disabled="actionPending" />
        </div>
        <div class="flex flex-wrap gap-2">
          <Button type="button" :disabled="actionPending || !codeInput.trim()" @click="submitCode">
            {{ actionPending ? $t('settings.claude.submittingCode') : $t('settings.claude.confirm') }}
          </Button>
          <Button type="button" variant="outline" class="border-destructive text-destructive hover:bg-destructive hover:text-white" :disabled="actionPending" @click="resetFlow">
            {{ $t('settings.claude.cancel') }}
          </Button>
        </div>
      </div>

      <div v-else-if="status.state === 'finishing'" class="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 class="h-4 w-4 animate-spin" />
        {{ $t('settings.claude.checking') }}
      </div>

      <div v-else-if="status.state === 'done'" class="space-y-3">
        <p class="text-sm text-emerald-600 dark:text-emerald-500">{{ $t('settings.claude.success') }}</p>
        <Button type="button" :disabled="actionPending" @click="resetFlow">{{ $t('settings.claude.ok') }}</Button>
      </div>

      <div v-else-if="status.state === 'error'" class="space-y-3">
        <p class="text-sm text-destructive">
          {{ status.errorMessage || $t('settings.claude.genericError') }}
        </p>
        <Button type="button" variant="outline" class="border-destructive text-destructive hover:bg-destructive hover:text-white" :disabled="actionPending" @click="resetFlow">
          {{ $t('settings.claude.retry') }}
        </Button>
      </div>
    </template>

    <p v-if="claudeError" class="text-sm text-destructive border-t pt-3">
      {{ claudeError }}
    </p>
  </div>
</template>
