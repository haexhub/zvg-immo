<script setup lang="ts">
import { ArrowLeft, ExternalLink, Loader2, Pencil, Trash2 } from 'lucide-vue-next'
import type { ClaudeSetupStatus } from '~/server/api/settings/claude/status.get'
import type { AdminLawyer } from '~/server/api/settings/lawyers/index.get'
import type { LlmMaxTokensKind, LlmProvider } from '~/server/utils/app-settings'

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
      await loadLlmConfig()
      await loadLlmProvider()
      await loadDisplaySettings()
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
    await loadLlmConfig()
    await loadLlmProvider()
    await loadDisplaySettings()
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

const adminLogoutError = ref<string | null>(null)

async function logout(): Promise<void> {
  adminLogoutError.value = null
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
    adminLogoutError.value = (err as { statusMessage?: string; message?: string }).statusMessage
      || (err as Error).message
      || t('settings.logoutAdminError')
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
  // `data.statusMessage` carries the createError() message from our own API
  // routes. The top-level `statusMessage`/`message` are ofetch's own fields —
  // for an HTTP/2 response (no reason phrase) they degrade to an unhelpful
  // `[GET] "/api/...": 404`, so only fall back to them when the server didn't
  // send a structured error body.
  const e = err as { data?: { statusMessage?: string }; statusMessage?: string; message?: string }
  return e.data?.statusMessage || e.statusMessage || e.message || fallback
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

/** Disconnects the linked Claude account (deletes the proxy's stored OAuth
 * credentials) — distinct from resetFlow(), which only cancels an in-flight
 * login attempt, and from logout(), which ends the admin session. */
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

// LLM-Konfiguration: Max-Output-Tokens pro Anwendungsfall, gegen
// /api/settings/llm-config (gleiches settings-auth-Muster wie oben).
const llmConfig = ref<Record<LlmMaxTokensKind, string>>({ extraction: '', summary: '', translation: '' })
const llmConfigError = ref<string | null>(null)
const llmConfigSaved = ref(false)
const llmConfigPending = ref(false)

async function loadLlmConfig(): Promise<void> {
  try {
    const res = await $fetch<Record<LlmMaxTokensKind, number>>('/api/settings/llm-config')
    llmConfig.value = {
      extraction: String(res.extraction),
      summary: String(res.summary),
      translation: String(res.translation),
    }
    llmConfigError.value = null
  } catch (err) {
    llmConfigError.value = normalizeSettingsError(err, t('settings.llm.loadError'))
  }
}

function parseLlmMaxTokens(raw: string): number | null {
  if (raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

async function saveLlmConfig(): Promise<void> {
  const extraction = parseLlmMaxTokens(llmConfig.value.extraction)
  const summary = parseLlmMaxTokens(llmConfig.value.summary)
  const translation = parseLlmMaxTokens(llmConfig.value.translation)
  if (extraction === null || summary === null || translation === null) {
    llmConfigError.value = t('settings.llm.invalidValue')
    return
  }

  llmConfigPending.value = true
  llmConfigError.value = null
  llmConfigSaved.value = false
  try {
    const res = await $fetch<Record<LlmMaxTokensKind, number>>('/api/settings/llm-config', {
      method: 'PUT',
      body: { extraction, summary, translation },
    })
    llmConfig.value = {
      extraction: String(res.extraction),
      summary: String(res.summary),
      translation: String(res.translation),
    }
    llmConfigSaved.value = true
  } catch (err) {
    llmConfigError.value = normalizeSettingsError(err, t('settings.llm.saveError'))
  } finally {
    llmConfigPending.value = false
  }
}

// LLM-Provider: aktiver Extraktions-Provider, gegen /api/settings/llm-provider
// (settings-auth-Muster wie oben). Presets füllen Base-URL/Modell beim
// Wechsel der Auswahl nur clientseitig vor — reine UX-Hilfe, keine
// Server-Logik.
const LLM_PROVIDER_PRESETS: Record<LlmProvider, { baseUrl: string; model: string }> = {
  'claude-proxy': { baseUrl: 'http://haex-claude-proxy:8080', model: 'claude-sonnet-5' },
  'gemini-native': { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-flash-latest' },
  'openai-compatible': { baseUrl: '', model: '' },
}
interface LlmProviderForm {
  provider: LlmProvider
  baseUrl: string
  model: string
  /** Write-only: leer beim Laden, egal ob ein Key gespeichert ist. */
  apiKey: string
}
const llmProviderForm = ref<LlmProviderForm>({ provider: 'claude-proxy', baseUrl: '', model: '', apiKey: '' })
const llmProviderOverrideActive = ref(false)
const llmProviderApiKeySet = ref(false)
const llmProviderEnvDefault = ref<{ provider: string; baseUrl: string; model: string } | null>(null)
const llmProviderError = ref<string | null>(null)
const llmProviderSaved = ref(false)
const llmProviderPending = ref(false)

// Modell-Select: welche Modelle für den aktuell gewählten Provider gültig/
// verfügbar sind, live von /api/settings/llm-provider/models geladen (siehe
// dort — claude-proxy fragt den Proxy selbst, gemini-native Googles
// ListModels). openai-compatible hat keine gemeinsame Discovery, dafür bleibt
// das Feld ein Freitext-Input.
const llmModelOptions = ref<{ id: string; label: string }[]>([])
const llmModelOptionsPending = ref(false)
const llmModelKeyRequired = ref(false)
const llmModelOptionsError = ref<string | null>(null)
let llmModelOptionsRequestId = 0

async function loadModelOptions(): Promise<void> {
  const requestId = ++llmModelOptionsRequestId
  llmModelOptionsError.value = null
  llmModelKeyRequired.value = false
  if (llmProviderForm.value.provider === 'openai-compatible') {
    llmModelOptions.value = []
    return
  }
  llmModelOptionsPending.value = true
  try {
    const res = await $fetch<{ models: { id: string; label: string }[]; keyRequired?: boolean }>(
      '/api/settings/llm-provider/models',
      {
        method: 'POST',
        body: {
          provider: llmProviderForm.value.provider,
          baseUrl: llmProviderForm.value.baseUrl,
          apiKey: llmProviderForm.value.apiKey || undefined,
        },
      },
    )
    if (requestId !== llmModelOptionsRequestId) return
    llmModelOptions.value = res.models
    llmModelKeyRequired.value = !!res.keyRequired
  } catch (err) {
    if (requestId !== llmModelOptionsRequestId) return
    llmModelOptions.value = []
    llmModelOptionsError.value = normalizeSettingsError(err, t('settings.llmProvider.modelLoadError'))
  } finally {
    if (requestId === llmModelOptionsRequestId) llmModelOptionsPending.value = false
  }
}

async function loadLlmProvider(): Promise<void> {
  try {
    const res = await $fetch<{
      override: { provider: LlmProvider; baseUrl: string; model: string; apiKeySet: boolean } | null
      envDefault: { provider: string; baseUrl: string; model: string }
    }>('/api/settings/llm-provider')
    llmProviderEnvDefault.value = res.envDefault
    llmProviderOverrideActive.value = !!res.override
    if (res.override) {
      llmProviderForm.value = {
        provider: res.override.provider,
        baseUrl: res.override.baseUrl,
        model: res.override.model,
        apiKey: '',
      }
      llmProviderApiKeySet.value = res.override.apiKeySet
    } else {
      llmProviderForm.value = {
        provider: (res.envDefault.provider as LlmProvider) || 'claude-proxy',
        baseUrl: res.envDefault.baseUrl,
        model: res.envDefault.model,
        apiKey: '',
      }
      llmProviderApiKeySet.value = false
    }
    llmProviderError.value = null
    await loadModelOptions()
  } catch (err) {
    llmProviderError.value = normalizeSettingsError(err, t('settings.llmProvider.loadError'))
  }
}

function onLlmProviderChange(): void {
  const preset = LLM_PROVIDER_PRESETS[llmProviderForm.value.provider]
  llmProviderForm.value.baseUrl = preset.baseUrl
  llmProviderForm.value.model = preset.model
  void loadModelOptions()
}

async function putLlmProvider(apiKey: string | undefined): Promise<void> {
  llmProviderPending.value = true
  llmProviderError.value = null
  llmProviderSaved.value = false
  try {
    const body: Record<string, unknown> = {
      provider: llmProviderForm.value.provider,
      baseUrl: llmProviderForm.value.baseUrl.trim(),
      model: llmProviderForm.value.model.trim(),
    }
    if (apiKey !== undefined) body.apiKey = apiKey
    const res = await $fetch<{ provider: LlmProvider; baseUrl: string; model: string; apiKeySet: boolean }>(
      '/api/settings/llm-provider',
      { method: 'PUT', body },
    )
    llmProviderOverrideActive.value = true
    llmProviderApiKeySet.value = res.apiKeySet
    llmProviderForm.value.apiKey = ''
    llmProviderSaved.value = true
    await loadModelOptions()
  } catch (err) {
    llmProviderError.value = normalizeSettingsError(err, t('settings.llmProvider.saveError'))
  } finally {
    llmProviderPending.value = false
  }
}

async function saveLlmProvider(): Promise<void> {
  if (!llmProviderForm.value.baseUrl.trim() || !llmProviderForm.value.model.trim()) {
    llmProviderError.value = t('settings.llmProvider.invalidValue')
    return
  }
  await putLlmProvider(llmProviderForm.value.apiKey || undefined)
}

async function clearLlmProviderApiKey(): Promise<void> {
  await putLlmProvider('')
}

async function resetLlmProvider(): Promise<void> {
  llmProviderPending.value = true
  llmProviderError.value = null
  try {
    await $fetch('/api/settings/llm-provider', { method: 'DELETE' })
    await loadLlmProvider()
  } catch (err) {
    llmProviderError.value = normalizeSettingsError(err, t('settings.llmProvider.resetError'))
  } finally {
    llmProviderPending.value = false
  }
}

// Dashboard-Anzeige: Standard für "Regex-only-Auktionen ausblenden" auf
// /search, gegen /api/settings/display (settings-auth-Muster wie oben).
const hideRulesOnlyDefault = ref(true)
const displayError = ref<string | null>(null)
const displaySaved = ref(false)
const displayPending = ref(false)

async function loadDisplaySettings(): Promise<void> {
  try {
    const res = await $fetch<{ hideRulesOnlyAuctions: boolean }>('/api/settings/display')
    hideRulesOnlyDefault.value = res.hideRulesOnlyAuctions
    displayError.value = null
  } catch (err) {
    displayError.value = normalizeSettingsError(err, t('settings.display.loadError'))
  }
}

async function saveDisplaySettings(): Promise<void> {
  displayPending.value = true
  displayError.value = null
  displaySaved.value = false
  try {
    const res = await $fetch<{ hideRulesOnlyAuctions: boolean }>('/api/settings/display', {
      method: 'PUT',
      body: { hideRulesOnlyAuctions: hideRulesOnlyDefault.value },
    })
    hideRulesOnlyDefault.value = res.hideRulesOnlyAuctions
    displaySaved.value = true
  } catch (err) {
    displayError.value = normalizeSettingsError(err, t('settings.display.saveError'))
  } finally {
    displayPending.value = false
  }
}

onMounted(probeSession)
onBeforeUnmount(stopPolling)
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

      <Card v-if="authed">
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

      <Card v-if="authed">
        <CardHeader>
          <CardTitle>{{ $t('settings.llm.title') }}</CardTitle>
        </CardHeader>
        <CardContent class="space-y-4">
          <p class="text-sm text-muted-foreground">
            {{ $t('settings.llm.description') }}
          </p>

          <p v-if="llmConfigError" class="text-sm text-destructive">{{ llmConfigError }}</p>
          <p v-if="llmConfigSaved" class="text-sm text-emerald-600 dark:text-emerald-500">{{ $t('settings.llm.saved') }}</p>

          <form class="grid grid-cols-1 sm:grid-cols-3 gap-3" @submit.prevent="saveLlmConfig">
            <div class="space-y-1">
              <Label>{{ $t('settings.llm.extractionLabel') }}</Label>
              <Input v-model="llmConfig.extraction" type="number" min="256" max="32768" step="1" />
            </div>
            <div class="space-y-1">
              <Label>{{ $t('settings.llm.summaryLabel') }}</Label>
              <Input v-model="llmConfig.summary" type="number" min="256" max="32768" step="1" />
            </div>
            <div class="space-y-1">
              <Label>{{ $t('settings.llm.translationLabel') }}</Label>
              <Input v-model="llmConfig.translation" type="number" min="256" max="32768" step="1" />
            </div>
            <div class="sm:col-span-3">
              <Button type="submit" :disabled="llmConfigPending">
                {{ llmConfigPending ? $t('settings.llm.saving') : $t('settings.llm.save') }}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card v-if="authed">
        <CardHeader>
          <CardTitle>{{ $t('settings.llmProvider.title') }}</CardTitle>
        </CardHeader>
        <CardContent class="space-y-4">
          <p class="text-sm text-muted-foreground">
            {{ $t('settings.llmProvider.description') }}
          </p>

          <p v-if="!llmProviderOverrideActive && llmProviderEnvDefault" class="text-sm text-muted-foreground">
            {{ $t('settings.llmProvider.usingEnvDefault', {
              provider: llmProviderEnvDefault.provider,
              baseUrl: llmProviderEnvDefault.baseUrl,
            }) }}
          </p>

          <p v-if="llmProviderError" class="text-sm text-destructive">{{ llmProviderError }}</p>
          <p v-if="llmProviderSaved" class="text-sm text-emerald-600 dark:text-emerald-500">{{ $t('settings.llmProvider.saved') }}</p>

          <form class="space-y-3" @submit.prevent="saveLlmProvider">
            <div class="space-y-1">
              <Label>{{ $t('settings.llmProvider.providerLabel') }}</Label>
              <Select v-model="llmProviderForm.provider" @update:model-value="onLlmProviderChange">
                <SelectTrigger class="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude-proxy">{{ $t('settings.llmProvider.providerClaudeProxy') }}</SelectItem>
                  <SelectItem value="gemini-native">{{ $t('settings.llmProvider.providerGeminiNative') }}</SelectItem>
                  <SelectItem value="openai-compatible">{{ $t('settings.llmProvider.providerOpenaiCompatible') }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div class="space-y-1">
                <Label>{{ $t('settings.llmProvider.baseUrlLabel') }}</Label>
                <Input v-model="llmProviderForm.baseUrl" />
              </div>
              <div class="space-y-1">
                <Label>{{ $t('settings.llmProvider.modelLabel') }}</Label>
                <Input v-if="llmProviderForm.provider === 'openai-compatible'" v-model="llmProviderForm.model" />
                <div v-else class="flex gap-2">
                  <Select v-model="llmProviderForm.model" :disabled="llmModelOptionsPending || !llmModelOptions.length">
                    <SelectTrigger class="w-full">
                      <SelectValue
                        :placeholder="llmModelOptionsPending ? $t('settings.llmProvider.modelLoading') : $t('settings.llmProvider.modelSelectPlaceholder')"
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="opt in llmModelOptions" :key="opt.id" :value="opt.id">{{ opt.label }}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button type="button" variant="outline" :disabled="llmModelOptionsPending" @click="loadModelOptions">
                    {{ $t('settings.llmProvider.modelRefresh') }}
                  </Button>
                </div>
                <p v-if="llmModelKeyRequired" class="text-xs text-muted-foreground">{{ $t('settings.llmProvider.modelKeyRequired') }}</p>
                <p v-if="llmModelOptionsError" class="text-xs text-destructive">{{ llmModelOptionsError }}</p>
              </div>
            </div>
            <div v-if="llmProviderForm.provider !== 'claude-proxy'" class="space-y-1">
              <Label>{{ $t('settings.llmProvider.apiKeyLabel') }}</Label>
              <div class="flex gap-2">
                <Input
                  v-model="llmProviderForm.apiKey"
                  type="password"
                  autocomplete="off"
                  :placeholder="llmProviderApiKeySet ? $t('settings.llmProvider.apiKeyPlaceholderSet') : $t('settings.llmProvider.apiKeyPlaceholderUnset')"
                />
                <Button
                  v-if="llmProviderApiKeySet"
                  type="button"
                  variant="outline"
                  :disabled="llmProviderPending"
                  @click="clearLlmProviderApiKey"
                >
                  {{ $t('settings.llmProvider.apiKeyClear') }}
                </Button>
              </div>
            </div>
            <div class="flex flex-wrap gap-2">
              <Button type="submit" :disabled="llmProviderPending">
                {{ llmProviderPending ? $t('settings.llmProvider.saving') : $t('settings.llmProvider.save') }}
              </Button>
              <Button
                v-if="llmProviderOverrideActive"
                type="button"
                variant="outline"
                :disabled="llmProviderPending"
                @click="resetLlmProvider"
              >
                {{ $t('settings.llmProvider.reset') }}
              </Button>
            </div>
          </form>

          <div v-if="llmProviderForm.provider === 'claude-proxy'" class="border-t pt-4 space-y-4">
            <div class="flex items-center justify-between">
              <h3 class="text-sm font-semibold">{{ $t('settings.claude.title') }}</h3>
              <Button
                v-if="status?.credentialsExist"
                type="button"
                variant="ghost"
                size="sm"
                :disabled="actionPending"
                @click="claudeLogout"
              >
                {{ $t('settings.claude.logout') }}
              </Button>
            </div>
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
          </div>
        </CardContent>
      </Card>

      <Card v-if="authed">
        <CardHeader>
          <CardTitle>{{ $t('settings.display.title') }}</CardTitle>
        </CardHeader>
        <CardContent class="space-y-4">
          <p class="text-sm text-muted-foreground">
            {{ $t('settings.display.description') }}
          </p>

          <p v-if="displayError" class="text-sm text-destructive">{{ displayError }}</p>
          <p v-if="displaySaved" class="text-sm text-emerald-600 dark:text-emerald-500">{{ $t('settings.display.saved') }}</p>

          <form class="space-y-3" @submit.prevent="saveDisplaySettings">
            <Label class="flex items-center gap-2">
              <Checkbox v-model="hideRulesOnlyDefault" /> {{ $t('settings.display.hideRulesOnlyLabel') }}
            </Label>
            <Button type="submit" :disabled="displayPending">
              {{ displayPending ? $t('settings.display.saving') : $t('settings.display.save') }}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card v-if="authed">
        <CardHeader>
          <CardTitle>{{ $t('settings.archive.title') }}</CardTitle>
        </CardHeader>
        <CardContent>
          <SettingsArchiveBrowser />
        </CardContent>
      </Card>
    </div>
  </main>
</template>
