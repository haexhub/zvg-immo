<script setup lang="ts">
import { ArrowLeft, ExternalLink, Loader2 } from 'lucide-vue-next'
import type { ClaudeSetupStatus } from '~/server/api/settings/claude/status.get'

useHead({ title: 'Einstellungen — Zwangsversteigerungen' })

// Auth state — probed on mount so a returning user with a valid cookie skips
// the password form.
const authed = ref(false)
const passwordInput = ref('')
const authError = ref<string | null>(null)
const authPending = ref(false)

async function probeSession(): Promise<void> {
  try {
    const res = await $fetch<{ authed: boolean }>('/api/settings/session', { cache: 'no-store' })
    authed.value = res.authed
    if (authed.value) await refreshStatus()
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
    await refreshStatus()
  } catch (err) {
    authError.value = (err as { statusMessage?: string; message?: string }).statusMessage
      || (err as Error).message
      || 'Login fehlgeschlagen.'
  } finally {
    authPending.value = false
  }
}

async function logout(): Promise<void> {
  await $fetch('/api/settings/logout', { method: 'POST' }).catch(() => {})
  authed.value = false
  status.value = null
  stopPolling()
}

// Claude OAuth flow state — mirrored from the proxy's setup state machine.
const status = ref<ClaudeSetupStatus | null>(null)
const codeInput = ref('')
const actionPending = ref(false)
const claudeError = ref<string | null>(null)

const isActiveFlow = computed(() =>
  !!status.value && ['awaiting-url', 'awaiting-code', 'finishing'].includes(status.value.state),
)

async function refreshStatus(): Promise<void> {
  try {
    status.value = await $fetch<ClaudeSetupStatus>('/api/settings/claude/status', { cache: 'no-store' })
    claudeError.value = null
  } catch (err) {
    claudeError.value = (err as { statusMessage?: string }).statusMessage
      || (err as Error).message
      || 'Status nicht erreichbar.'
  }
}

async function startLogin(): Promise<void> {
  claudeError.value = null
  actionPending.value = true
  try {
    await $fetch('/api/settings/claude/login', { method: 'POST' })
    await refreshStatus()
  } catch (err) {
    claudeError.value = (err as { statusMessage?: string }).statusMessage
      || (err as Error).message
      || 'Login-Start fehlgeschlagen.'
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
    claudeError.value = (err as { statusMessage?: string }).statusMessage
      || (err as Error).message
      || 'Code-Übermittlung fehlgeschlagen.'
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
    claudeError.value = (err as { statusMessage?: string }).statusMessage
      || (err as Error).message
      || 'Zurücksetzen fehlgeschlagen.'
  } finally {
    actionPending.value = false
  }
}

// Poll while a flow is in-flight so state changes surface without user action.
let pollTimer: ReturnType<typeof setInterval> | null = null
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

onMounted(probeSession)
onBeforeUnmount(stopPolling)
</script>

<template>
  <main class="h-full overflow-y-auto px-4 py-6">
    <div class="max-w-2xl mx-auto space-y-6">
      <NuxtLink to="/" class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft class="h-4 w-4" /> Zurück zur Übersicht
      </NuxtLink>
      <h1 class="text-2xl font-bold tracking-tight">Einstellungen</h1>

      <section v-if="!authed" class="rounded-xl border bg-card p-5 space-y-4">
        <h2 class="text-base font-semibold">Anmeldung</h2>
        <p class="text-sm text-muted-foreground">
          Diese Seite ist passwortgeschützt.
        </p>
        <form class="space-y-3" @submit.prevent="login">
          <input
            v-model="passwordInput"
            type="password"
            autocomplete="current-password"
            placeholder="Passwort"
            class="w-full h-10 rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            :disabled="authPending"
          >
          <p v-if="authError" class="text-sm text-destructive">{{ authError }}</p>
          <button
            type="submit"
            class="w-full h-10 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            :disabled="authPending || !passwordInput"
          >{{ authPending ? 'Prüfe …' : 'Anmelden' }}</button>
        </form>
      </section>

      <section v-else class="rounded-xl border bg-card p-5 space-y-4">
        <div class="flex items-baseline justify-between">
          <h2 class="text-base font-semibold">Claude AI-Anmeldung</h2>
          <button
            type="button"
            class="text-xs text-muted-foreground hover:text-foreground"
            @click="logout"
          >Abmelden</button>
        </div>
        <p class="text-sm text-muted-foreground">
          Verknüpft dein Claude Pro/Max-Abo mit dem Server, damit der Enrich-Task Größen aus Gutachten-PDFs extrahieren kann.
        </p>

        <p v-if="!status" class="text-sm text-muted-foreground">Lade Status …</p>

        <template v-else>
          <div
            v-if="status.state === 'idle' && !status.hasCredentials"
            class="space-y-3"
          >
            <p class="text-sm">Status: <span class="font-medium">Nicht verbunden</span></p>
            <button
              type="button"
              class="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              :disabled="actionPending"
              @click="startLogin"
            >{{ actionPending ? 'Starte …' : 'Login starten' }}</button>
          </div>

          <div
            v-else-if="status.state === 'idle' && status.hasCredentials"
            class="space-y-3"
          >
            <p class="text-sm text-emerald-600 dark:text-emerald-500">✓ Bereits angemeldet</p>
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="h-9 rounded-md border px-4 text-sm hover:border-primary hover:text-primary transition-colors disabled:opacity-50"
                :disabled="actionPending"
                @click="startLogin"
              >Neu verknüpfen</button>
            </div>
          </div>

          <div v-else-if="status.state === 'awaiting-url'" class="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 class="h-4 w-4 animate-spin" />
            Öffne Anthropic-Login …
          </div>

          <div v-else-if="status.state === 'awaiting-code'" class="space-y-4">
            <div>
              <p class="text-sm mb-2">1. Öffne die Anthropic-Login-Seite und autorisiere den Zugriff:</p>
              <a
                v-if="status.oauthUrl"
                :href="status.oauthUrl"
                target="_blank"
                rel="noopener"
                class="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm hover:border-primary hover:text-primary transition-colors"
              >
                <ExternalLink class="h-4 w-4" />
                OAuth-Seite öffnen
              </a>
            </div>
            <div>
              <p class="text-sm mb-2">2. Kopiere den Code und füge ihn hier ein:</p>
              <textarea
                v-model="codeInput"
                rows="2"
                placeholder="Code aus platform.claude.com"
                class="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                :disabled="actionPending"
              />
            </div>
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                :disabled="actionPending || !codeInput.trim()"
                @click="submitCode"
              >{{ actionPending ? 'Übertrage …' : 'Bestätigen' }}</button>
              <button
                type="button"
                class="h-9 rounded-md border border-destructive px-4 text-sm text-destructive hover:bg-destructive hover:text-white transition-colors disabled:opacity-50"
                :disabled="actionPending"
                @click="resetFlow"
              >Abbrechen</button>
            </div>
          </div>

          <div v-else-if="status.state === 'finishing'" class="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 class="h-4 w-4 animate-spin" />
            Prüfe Anmeldung …
          </div>

          <div v-else-if="status.state === 'done'" class="space-y-3">
            <p class="text-sm text-emerald-600 dark:text-emerald-500">✓ Erfolgreich verbunden</p>
            <button
              type="button"
              class="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              :disabled="actionPending"
              @click="resetFlow"
            >OK</button>
          </div>

          <div v-else-if="status.state === 'error'" class="space-y-3">
            <p class="text-sm text-destructive">
              {{ status.errorMessage || 'Ein Fehler ist aufgetreten.' }}
            </p>
            <button
              type="button"
              class="h-9 rounded-md border border-destructive px-4 text-sm text-destructive hover:bg-destructive hover:text-white transition-colors disabled:opacity-50"
              :disabled="actionPending"
              @click="resetFlow"
            >Erneut versuchen</button>
          </div>
        </template>

        <p v-if="claudeError" class="text-sm text-destructive border-t pt-3">
          {{ claudeError }}
        </p>
      </section>
    </div>
  </main>
</template>
