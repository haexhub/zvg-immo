<script setup lang="ts">
import { ArrowLeft, ExternalLink, Loader2, Pencil, Trash2 } from 'lucide-vue-next'
import type { ClaudeSetupStatus } from '~/server/api/settings/claude/status.get'
import type { AdminLawyer } from '~/server/api/settings/lawyers/index.get'

const { t } = useI18n()
useHead({ title: t('settings.title') })

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
      || t('settings.login.error')
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
      || t('settings.claude.logoutError')
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
    return t('settings.claude.sessionExpired')
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
    lawyersError.value = normalizeSettingsError(err, t('settings.lawyers.loadError'))
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
    lawyersError.value = normalizeSettingsError(err, t('settings.lawyers.saveError'))
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
    lawyersError.value = normalizeSettingsError(err, t('settings.lawyers.updateError'))
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
      ? ((err as { statusMessage?: string }).statusMessage ?? t('settings.lawyers.hasInquiries'))
      : normalizeSettingsError(err, t('settings.lawyers.deleteError'))
  } finally {
    lawyersPending.value = false
  }
}

onMounted(probeSession)
onBeforeUnmount(stopPolling)
</script>

<template>
  <main class="px-4 py-6">
    <div class="max-w-2xl mx-auto space-y-6">
      <NuxtLink to="/search" class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft class="h-4 w-4" /> {{ $t('settings.back') }}
      </NuxtLink>
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

      <Card v-else>
        <CardHeader>
          <CardTitle>{{ $t('settings.claude.title') }}</CardTitle>
          <CardAction>
            <Button type="button" variant="ghost" size="sm" @click="logout">{{ $t('settings.claude.logout') }}</Button>
          </CardAction>
        </CardHeader>
        <CardContent class="space-y-4">
          <p class="text-sm text-muted-foreground">
            {{ $t('settings.claude.description') }}
          </p>

          <p v-if="!status" class="text-sm text-muted-foreground">{{ $t('settings.claude.loadingStatus') }}</p>

          <template v-else>
            <div
              v-if="status.state === 'idle' && !status.credentialsExist"
              class="space-y-3"
            >
              <p class="text-sm">{{ $t('settings.claude.statusLabel') }} <span class="font-medium">{{ $t('settings.claude.notConnected') }}</span></p>
              <Button type="button" :disabled="actionPending" @click="startLogin">
                {{ actionPending ? $t('settings.claude.starting') : $t('settings.claude.startLogin') }}
              </Button>
            </div>

            <div
              v-else-if="status.state === 'idle' && status.credentialsExist"
              class="space-y-3"
            >
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
                <Textarea
                  v-model="codeInput"
                  rows="2"
                  :placeholder="$t('settings.claude.codePlaceholder')"
                  class="font-mono"
                  :disabled="actionPending"
                />
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{{ $t('settings.lawyers.title') }}</CardTitle>
          <CardAction>
            <Button type="button" size="sm" @click="startCreate">{{ $t('settings.lawyers.add') }}</Button>
          </CardAction>
        </CardHeader>
        <CardContent class="space-y-4">
          <p class="text-sm text-muted-foreground">
            {{ $t('settings.lawyers.description') }}
          </p>

          <p v-if="lawyersError" class="text-sm text-destructive">{{ lawyersError }}</p>

          <Table v-if="lawyers.length" class="min-w-[640px]">
            <TableHeader>
              <TableRow>
                <TableHead>{{ $t('settings.lawyers.colName') }}</TableHead>
                <TableHead>{{ $t('settings.lawyers.colCountries') }}</TableHead>
                <TableHead>{{ $t('settings.lawyers.colCommission') }}</TableHead>
                <TableHead>{{ $t('settings.lawyers.colStatus') }}</TableHead>
                <TableHead class="text-right">{{ $t('settings.lawyers.colActions') }}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="l in lawyers" :key="l.id">
                <TableCell>
                  <div class="font-medium">{{ l.name }}</div>
                  <div v-if="l.firm" class="text-xs text-muted-foreground">{{ l.firm }}</div>
                </TableCell>
                <TableCell class="uppercase text-xs">{{ l.countries.join(', ') }}</TableCell>
                <TableCell class="tabular-nums">{{ l.commissionCents != null ? (l.commissionCents / 100).toFixed(2) + ' €' : '–' }}</TableCell>
                <TableCell>
                  <span :class="l.active ? 'text-emerald-600 dark:text-emerald-500' : 'text-muted-foreground'">
                    {{ l.active ? $t('settings.lawyers.active') : $t('settings.lawyers.inactive') }}
                  </span>
                </TableCell>
                <TableCell>
                  <div class="flex items-center justify-end gap-2">
                    <Button type="button" variant="ghost" size="icon" :title="$t('settings.lawyers.edit')" @click="startEdit(l)">
                      <Pencil class="h-4 w-4" />
                    </Button>
                    <Button type="button" variant="outline" size="sm" :disabled="lawyersPending" @click="toggleActive(l)">
                      {{ l.active ? $t('settings.lawyers.deactivate') : $t('settings.lawyers.activate') }}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      :title="$t('settings.lawyers.delete')"
                      class="hover:text-destructive"
                      :disabled="lawyersPending"
                      @click="deleteLawyer(l)"
                    >
                      <Trash2 class="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <p v-else class="text-sm text-muted-foreground">{{ $t('settings.lawyers.empty') }}</p>

          <form v-if="showForm" class="border-t pt-4 space-y-3" @submit.prevent="submitLawyerForm">
            <h3 class="text-sm font-semibold">{{ editingId ? $t('settings.lawyers.editHeading') : $t('settings.lawyers.createHeading') }}</h3>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input v-model="form.name" :placeholder="$t('settings.lawyers.namePlaceholder')" required />
              <Input v-model="form.firm" :placeholder="$t('settings.lawyers.firmPlaceholder')" />
              <Input v-model="form.email" type="email" :placeholder="$t('settings.lawyers.emailPlaceholder')" required />
              <Input v-model="form.phone" :placeholder="$t('settings.lawyers.phonePlaceholder')" />
              <Input v-model="form.countries" :placeholder="$t('settings.lawyers.countriesPlaceholder')" required />
              <Input v-model="form.specialization" :placeholder="$t('settings.lawyers.specializationPlaceholder')" />
              <Input v-model="form.languages" :placeholder="$t('settings.lawyers.languagesPlaceholder')" />
              <Input v-model="form.website" :placeholder="$t('settings.lawyers.websitePlaceholder')" />
              <Input v-model="form.commissionEur" type="number" step="0.01" min="0" :placeholder="$t('settings.lawyers.commissionPlaceholder')" />
              <Label class="flex items-center gap-2">
                <Checkbox v-model="form.active" /> {{ $t('settings.lawyers.activeLabel') }}
              </Label>
            </div>
            <div class="flex gap-2">
              <Button type="submit" :disabled="lawyersPending">{{ lawyersPending ? $t('settings.lawyers.saving') : $t('settings.lawyers.save') }}</Button>
              <Button type="button" variant="outline" @click="cancelForm">{{ $t('settings.lawyers.cancel') }}</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  </main>
</template>
