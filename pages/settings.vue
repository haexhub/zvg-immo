<script setup lang="ts">
import { ArrowLeft, ExternalLink, Loader2, Pencil, Trash2 } from 'lucide-vue-next'
import type { ClaudeSetupStatus } from '~/server/api/settings/claude/status.get'
import type { AdminLawyer } from '~/server/api/settings/lawyers/index.get'

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
    if (authed.value) {
      await refreshStatus()
      await loadLawyers()
    }
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
    await loadLawyers()
  } catch (err) {
    authError.value = (err as { statusMessage?: string; message?: string }).statusMessage
      || (err as Error).message
      || 'Login fehlgeschlagen.'
  } finally {
    authPending.value = false
  }
}

function clearAuthState(): void {
  authed.value = false
  status.value = null
  stopPolling()
}

async function logout(): Promise<void> {
  claudeError.value = null
  try {
    await $fetch('/api/settings/logout', { method: 'POST' })
    clearAuthState()
  } catch (err) {
    // 401 means the cookie was already invalid — that's a successful logout
    // from the user's perspective. Any other error means the server-side
    // cookie may still be valid; keep the UI signed in so the user notices.
    if ((err as { statusCode?: number }).statusCode === 401) {
      clearAuthState()
      return
    }
    claudeError.value = (err as { statusMessage?: string; message?: string }).statusMessage
      || (err as Error).message
      || 'Abmelden fehlgeschlagen.'
  }
}

/**
 * A 401 on a protected route means the session cookie expired or was
 * rotated — flip back to the login form instead of leaving the UI stuck in
 * the authenticated branch (which would keep polling and stacking 401s).
 */
function normalizeSettingsError(err: unknown, fallback: string): string {
  if ((err as { statusCode?: number }).statusCode === 401) {
    clearAuthState()
    return 'Sitzung abgelaufen.'
  }
  return (err as { statusMessage?: string; message?: string }).statusMessage
    || (err as Error).message
    || fallback
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
    claudeError.value = normalizeSettingsError(err, 'Status nicht erreichbar.')
  }
}

async function startLogin(): Promise<void> {
  claudeError.value = null
  actionPending.value = true
  try {
    await $fetch('/api/settings/claude/login', { method: 'POST' })
    await refreshStatus()
  } catch (err) {
    claudeError.value = normalizeSettingsError(err, 'Login-Start fehlgeschlagen.')
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
    claudeError.value = normalizeSettingsError(err, 'Code-Übermittlung fehlgeschlagen.')
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
    claudeError.value = normalizeSettingsError(err, 'Zurücksetzen fehlgeschlagen.')
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

// Anwälte (Phase 4): admin CRUD for the lawyer-referral catalog, against
// /api/settings/lawyers/* (inherits the settings-auth guard above it, same
// as the Claude section — no separate auth here).
const lawyers = ref<AdminLawyer[]>([])
const lawyersError = ref<string | null>(null)
const lawyersPending = ref(false)
const editingId = ref<string | null>(null)
const showForm = ref(false)

interface LawyerFormState {
  name: string
  firm: string
  email: string
  phone: string
  countries: string
  specialization: string
  languages: string
  website: string
  commissionEur: string
  active: boolean
}
function emptyForm(): LawyerFormState {
  return {
    name: '', firm: '', email: '', phone: '', countries: '',
    specialization: '', languages: '', website: '', commissionEur: '', active: true,
  }
}
const form = ref<LawyerFormState>(emptyForm())

async function loadLawyers(): Promise<void> {
  try {
    lawyers.value = await $fetch<AdminLawyer[]>('/api/settings/lawyers')
    lawyersError.value = null
  } catch (err) {
    lawyersError.value = normalizeSettingsError(err, 'Anwälte konnten nicht geladen werden.')
  }
}

function startCreate(): void {
  editingId.value = null
  form.value = emptyForm()
  showForm.value = true
}
function startEdit(l: AdminLawyer): void {
  editingId.value = l.id
  form.value = {
    name: l.name,
    firm: l.firm ?? '',
    email: l.email,
    phone: l.phone ?? '',
    countries: l.countries.join(', '),
    specialization: l.specialization ?? '',
    languages: (l.languages ?? []).join(', '),
    website: l.website ?? '',
    commissionEur: l.commissionCents != null ? (l.commissionCents / 100).toFixed(2) : '',
    active: l.active,
  }
  showForm.value = true
}
function cancelForm(): void {
  showForm.value = false
  editingId.value = null
}

function splitList(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter(Boolean)
}

async function submitLawyerForm(): Promise<void> {
  lawyersPending.value = true
  lawyersError.value = null
  const commissionEur = form.value.commissionEur.trim()
  const body = {
    name: form.value.name.trim(),
    firm: form.value.firm.trim() || null,
    email: form.value.email.trim(),
    phone: form.value.phone.trim() || null,
    countries: splitList(form.value.countries),
    specialization: form.value.specialization.trim() || null,
    languages: splitList(form.value.languages),
    website: form.value.website.trim() || null,
    commissionCents: commissionEur ? Math.round(parseFloat(commissionEur) * 100) : null,
    active: form.value.active,
  }
  try {
    if (editingId.value) {
      await $fetch(`/api/settings/lawyers/${editingId.value}`, { method: 'PUT', body })
    } else {
      await $fetch('/api/settings/lawyers', { method: 'POST', body })
    }
    await loadLawyers()
    cancelForm()
  } catch (err) {
    lawyersError.value = normalizeSettingsError(err, 'Speichern fehlgeschlagen.')
  } finally {
    lawyersPending.value = false
  }
}

async function toggleActive(l: AdminLawyer): Promise<void> {
  lawyersPending.value = true
  lawyersError.value = null
  try {
    await $fetch(`/api/settings/lawyers/${l.id}`, {
      method: 'PUT',
      body: {
        name: l.name, firm: l.firm, email: l.email, phone: l.phone,
        countries: l.countries, specialization: l.specialization, languages: l.languages,
        website: l.website, commissionCents: l.commissionCents, active: !l.active,
      },
    })
    await loadLawyers()
  } catch (err) {
    lawyersError.value = normalizeSettingsError(err, 'Aktualisieren fehlgeschlagen.')
  } finally {
    lawyersPending.value = false
  }
}

async function deleteLawyer(l: AdminLawyer): Promise<void> {
  lawyersPending.value = true
  lawyersError.value = null
  try {
    await $fetch(`/api/settings/lawyers/${l.id}`, { method: 'DELETE' })
    await loadLawyers()
  } catch (err) {
    // 409 = lawyer has dependent inquiries (FK RESTRICT) — steer towards
    // deactivating instead of deleting.
    lawyersError.value = (err as { statusCode?: number }).statusCode === 409
      ? ((err as { statusMessage?: string }).statusMessage ?? 'Anwalt hat bereits Anfragen — bitte deaktivieren statt löschen.')
      : normalizeSettingsError(err, 'Löschen fehlgeschlagen.')
  } finally {
    lawyersPending.value = false
  }
}

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
            v-if="status.state === 'idle' && !status.credentialsExist"
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
            v-else-if="status.state === 'idle' && status.credentialsExist"
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

      <section class="rounded-xl border bg-card p-5 space-y-4">
        <div class="flex items-baseline justify-between">
          <h2 class="text-base font-semibold">Anwälte</h2>
          <button
            type="button"
            class="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            @click="startCreate"
          >+ Anwalt anlegen</button>
        </div>
        <p class="text-sm text-muted-foreground">
          Katalog der vermittelten Anwälte (Pay-per-Lead). Anfragen laufen über die Objektseite; die E-Mail-Adresse wird nie an den Client ausgeliefert.
        </p>

        <p v-if="lawyersError" class="text-sm text-destructive">{{ lawyersError }}</p>

        <div v-if="lawyers.length" class="overflow-x-auto -mx-5">
          <table class="w-full text-sm min-w-[640px]">
            <thead>
              <tr class="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th class="px-5 py-2 font-medium">Name</th>
                <th class="px-5 py-2 font-medium">Länder</th>
                <th class="px-5 py-2 font-medium">Provision</th>
                <th class="px-5 py-2 font-medium">Status</th>
                <th class="px-5 py-2 font-medium text-right">Aktionen</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in lawyers" :key="l.id" class="border-b last:border-0">
                <td class="px-5 py-2">
                  <div class="font-medium">{{ l.name }}</div>
                  <div v-if="l.firm" class="text-xs text-muted-foreground">{{ l.firm }}</div>
                </td>
                <td class="px-5 py-2 uppercase text-xs">{{ l.countries.join(', ') }}</td>
                <td class="px-5 py-2 tabular-nums">{{ l.commissionCents != null ? (l.commissionCents / 100).toFixed(2) + ' €' : '–' }}</td>
                <td class="px-5 py-2">
                  <span :class="l.active ? 'text-emerald-600 dark:text-emerald-500' : 'text-muted-foreground'">
                    {{ l.active ? 'Aktiv' : 'Deaktiviert' }}
                  </span>
                </td>
                <td class="px-5 py-2">
                  <div class="flex items-center justify-end gap-2">
                    <button type="button" title="Bearbeiten" class="text-muted-foreground hover:text-foreground" @click="startEdit(l)">
                      <Pencil class="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      class="text-xs rounded-md border px-2 py-1 hover:border-primary hover:text-primary"
                      :disabled="lawyersPending"
                      @click="toggleActive(l)"
                    >{{ l.active ? 'Deaktivieren' : 'Aktivieren' }}</button>
                    <button
                      type="button"
                      title="Löschen (nur ohne Anfragen möglich)"
                      class="text-muted-foreground hover:text-destructive"
                      :disabled="lawyersPending"
                      @click="deleteLawyer(l)"
                    >
                      <Trash2 class="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="text-sm text-muted-foreground">Noch keine Anwälte angelegt.</p>

        <form v-if="showForm" class="border-t pt-4 space-y-3" @submit.prevent="submitLawyerForm">
          <h3 class="text-sm font-semibold">{{ editingId ? 'Anwalt bearbeiten' : 'Neuen Anwalt anlegen' }}</h3>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input v-model="form.name" placeholder="Name *" required class="h-9 rounded-md border bg-background px-3 text-sm" />
            <input v-model="form.firm" placeholder="Kanzlei" class="h-9 rounded-md border bg-background px-3 text-sm" />
            <input v-model="form.email" type="email" placeholder="E-Mail *" required class="h-9 rounded-md border bg-background px-3 text-sm" />
            <input v-model="form.phone" placeholder="Telefon" class="h-9 rounded-md border bg-background px-3 text-sm" />
            <input v-model="form.countries" placeholder="Länder (z.B. de, at) *" required class="h-9 rounded-md border bg-background px-3 text-sm" />
            <input v-model="form.specialization" placeholder="Spezialisierung" class="h-9 rounded-md border bg-background px-3 text-sm" />
            <input v-model="form.languages" placeholder="Sprachen (z.B. Deutsch, Englisch)" class="h-9 rounded-md border bg-background px-3 text-sm" />
            <input v-model="form.website" placeholder="Website" class="h-9 rounded-md border bg-background px-3 text-sm" />
            <input v-model="form.commissionEur" type="number" step="0.01" min="0" placeholder="Provision pro Lead (EUR)" class="h-9 rounded-md border bg-background px-3 text-sm" />
            <label class="flex items-center gap-2 text-sm">
              <input v-model="form.active" type="checkbox" class="h-4 w-4" /> Aktiv
            </label>
          </div>
          <div class="flex gap-2">
            <button
              type="submit"
              class="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              :disabled="lawyersPending"
            >{{ lawyersPending ? 'Speichere …' : 'Speichern' }}</button>
            <button type="button" class="h-9 rounded-md border px-4 text-sm" @click="cancelForm">Abbrechen</button>
          </div>
        </form>
      </section>
    </div>
  </main>
</template>
