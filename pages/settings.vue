<script setup lang="ts">
import { ArrowLeft, ExternalLink, Loader2, Pencil, RefreshCw, Trash2 } from 'lucide-vue-next'
import type { ClaudeSetupStatus } from '~/server/api/settings/claude/status.get'
import type { AdminLawyer } from '~/server/api/settings/lawyers/index.get'
import type { LlmExecutionMode, LlmMaxTokensKind, LlmProvider, LlmProviderScope } from '~/server/utils/app-settings'
import type { CountrySourceSetting, CountrySourceSettings } from '~/server/utils/country-source-settings'

const { t, te } = useI18n()
const countryLabel = useCountryLabel()
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
      await loadLlmProfiles()
      await loadLlmBatchJobs()
      await loadDisplaySettings()
      await loadCountrySources()
      await loadExternalDataSources()
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
    await loadLlmProfiles()
    await loadLlmBatchJobs()
    await loadDisplaySettings()
    await loadCountrySources()
    await loadExternalDataSources()
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
  stopProgressPolling()
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
// /api/settings/llm-config (gleiches settings-auth-Muster wie oben). Die
// Kind-Liste kommt generisch aus der GET-Response (extraction/translation
// plus ein Eintrag pro registriertem Insight, siehe app-settings.ts'
// KINDS) — kein Server-only-Registry-Import auf der Client-Seite nötig,
// und ein neuer Insight erscheint hier automatisch ohne Template-Änderung.
const llmConfig = ref<Record<LlmMaxTokensKind, string>>({})
const llmConfigError = ref<string | null>(null)
const llmConfigSaved = ref(false)
const llmConfigPending = ref(false)
// Guards saveLlmConfig against submitting before the GET below has populated
// llmConfig — the card renders as soon as `authed` flips true, which is
// before this await resolves, so an empty-object PUT is otherwise reachable.
const llmConfigLoaded = ref(false)
const llmConfigSaveDisabled = computed(
  () => llmConfigPending.value || !llmConfigLoaded.value || Object.keys(llmConfig.value).length === 0,
)

function llmKindLabel(kind: string): string {
  const key = `settings.llm.${kind}Label`
  return te(key) ? t(key) : kind
}

async function loadLlmConfig(): Promise<void> {
  try {
    const res = await $fetch<Record<LlmMaxTokensKind, number>>('/api/settings/llm-config')
    llmConfig.value = Object.fromEntries(Object.entries(res).map(([kind, value]) => [kind, String(value)]))
    llmConfigError.value = null
    llmConfigLoaded.value = true
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
  const parsed: Record<string, number> = {}
  for (const [kind, raw] of Object.entries(llmConfig.value)) {
    const value = parseLlmMaxTokens(raw)
    if (value === null) {
      llmConfigError.value = t('settings.llm.invalidValue')
      return
    }
    parsed[kind] = value
  }

  llmConfigPending.value = true
  llmConfigError.value = null
  llmConfigSaved.value = false
  try {
    const res = await $fetch<Record<LlmMaxTokensKind, number>>('/api/settings/llm-config', {
      method: 'PUT',
      body: parsed,
    })
    llmConfig.value = Object.fromEntries(Object.entries(res).map(([kind, value]) => [kind, String(value)]))
    llmConfigSaved.value = true
  } catch (err) {
    llmConfigError.value = normalizeSettingsError(err, t('settings.llm.saveError'))
  } finally {
    llmConfigPending.value = false
  }
}

// LLM-Provider: wiederverwendbare Provider-Profile (Zugangsdaten) gegen
// /api/settings/llm-profiles (Liste/Anlegen/Bearbeiten) und
// /api/settings/llm-profiles/:id (Löschen, sofort wirksam). Welches Profil
// für Dokument-Extraktion bzw. Text-Übersetzung genutzt wird, ist eine
// eigene Zuordnung gegen /api/settings/llm-assignments — beide Ressourcen
// werden zusammen per GET /api/settings/llm-profiles geladen, aber
// unabhängig voneinander gespeichert (eigene Card, eigener Save-Button).
// Presets füllen Base-URL/Modell beim Wechsel der Provider-Auswahl nur
// clientseitig vor — reine UX-Hilfe, keine Server-Logik.
const LLM_PROVIDER_PRESETS: Record<LlmProvider, { baseUrl: string; model: string }> = {
  'claude-proxy': { baseUrl: 'http://haex-claude-proxy:8080', model: 'claude-sonnet-5' },
  'gemini-native': { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-flash-latest' },
  'openai-compatible': { baseUrl: 'https://api.openai.com/v1', model: '' },
}
const LLM_PROVIDER_SCOPES: LlmProviderScope[] = ['extraction', 'translation']

// Modell-Select: welche Modelle für den aktuell gewählten Provider gültig/
// verfügbar sind, live von /api/settings/llm-provider/models geladen (siehe
// dort — claude-proxy fragt den Proxy selbst, gemini-native Googles
// ListModels). openai-compatible hat keine gemeinsame Discovery, dafür bleibt
// das Feld ein Freitext-Input.
function isOpenAiBatchBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    return (
      url.protocol === 'https:' &&
      url.hostname === 'api.openai.com' &&
      url.pathname.replace(/\/+$/, '') === '/v1'
    )
  } catch {
    return false
  }
}

interface LlmProviderProfileForm {
  id: string
  name: string
  provider: LlmProvider
  baseUrl: string
  model: string
  executionMode: LlmExecutionMode
  apiKey: string
  apiKeySet: boolean
  apiKeyMissing: boolean
  clearApiKey: boolean
  modelOptions: { id: string; label: string }[]
  modelOptionsPending: boolean
  modelKeyRequired: boolean
  modelOptionsError: string | null
  modelOptionsRequestId: number
}

interface LlmProfilesResponse {
  profiles: Array<{
    id: string
    name: string
    provider: LlmProvider
    baseUrl: string
    model: string
    executionMode: LlmExecutionMode
    apiKeySet: boolean
    apiKeyMissing: boolean
  }>
  assignments: Partial<Record<LlmProviderScope, string>>
  effective: Record<LlmProviderScope, {
    provider: string
    baseUrl: string
    model: string
    executionMode: LlmExecutionMode
  }>
}

function localProfileId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `profile_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}

function makeProfileForm(input?: Partial<LlmProviderProfileForm>): LlmProviderProfileForm {
  const preset = LLM_PROVIDER_PRESETS[input?.provider ?? 'gemini-native']
  return {
    id: input?.id ?? localProfileId(),
    name: input?.name ?? '',
    provider: input?.provider ?? 'gemini-native',
    baseUrl: input?.baseUrl ?? preset.baseUrl,
    model: input?.model ?? preset.model,
    executionMode: input?.executionMode ?? 'sync',
    apiKey: '',
    apiKeySet: input?.apiKeySet ?? false,
    apiKeyMissing: input?.apiKeyMissing ?? false,
    clearApiKey: false,
    modelOptions: [],
    modelOptionsPending: false,
    modelKeyRequired: false,
    modelOptionsError: null,
    modelOptionsRequestId: 0,
  }
}

const llmProfiles = ref<LlmProviderProfileForm[]>([])
// ids known to exist server-side (from the last load) — deleting a profile
// not in this set (an unsaved "Profil hinzufügen" row) is a local-only
// splice, no DELETE call needed.
const persistedLlmProfileIds = ref<Set<string>>(new Set())
const NO_LLM_PROFILE = '__none'
const llmProfileAssignments = reactive<Record<LlmProviderScope, string>>({
  extraction: NO_LLM_PROFILE,
  translation: NO_LLM_PROFILE,
})
const llmProfileEffective = ref<LlmProfilesResponse['effective'] | null>(null)
const llmProfilesError = ref<string | null>(null)
const llmProfilesSaved = ref(false)
const llmProfilesPending = ref(false)
const llmAssignmentsError = ref<string | null>(null)
const llmAssignmentsSaved = ref(false)
const llmAssignmentsPending = ref(false)

function profileSupportsBatch(profile: LlmProviderProfileForm): boolean {
  return profile.provider === 'gemini-native' ||
    profile.provider === 'claude-proxy' ||
    (profile.provider === 'openai-compatible' && isOpenAiBatchBaseUrl(profile.baseUrl))
}

// The last *real* batch submit attempt for this provider was rejected (e.g.
// Gemini's free tier returns 400 FAILED_PRECONDITION on every
// batchGenerateContent call) — a static config shape can't know this, only
// an actual attempt can. Backed by /api/settings/llm-batch-jobs'
// `capabilities` (server/utils/llm-batch-jobs.ts's recordLlmBatchCapability).
function providerCapability(provider: LlmProvider): LlmBatchCapability | null {
  return llmBatchJobs.value?.capabilities?.[provider] ?? null
}

function providerBatchBroken(provider: LlmProvider): boolean {
  return providerCapability(provider)?.ok === false
}

function profileCanSelectBatch(profile: LlmProviderProfileForm): boolean {
  if (providerBatchBroken(profile.provider)) return false
  return profile.provider === 'gemini-native' ||
    (
      (profile.provider === 'claude-proxy' ||
        (profile.provider === 'openai-compatible' && isOpenAiBatchBaseUrl(profile.baseUrl))) &&
      (profile.apiKeySet || !!profile.apiKey)
    )
}

async function loadProfileModelOptions(profile: LlmProviderProfileForm): Promise<void> {
  const requestId = ++profile.modelOptionsRequestId
  profile.modelOptionsError = null
  profile.modelKeyRequired = false
  if (profile.provider === 'openai-compatible') {
    profile.modelOptions = []
    return
  }
  profile.modelOptionsPending = true
  try {
    const res = await $fetch<{ models: { id: string; label: string }[]; keyRequired?: boolean }>(
      '/api/settings/llm-provider/models',
      {
        method: 'POST',
        body: {
          profileId: profile.id,
          provider: profile.provider,
          baseUrl: profile.baseUrl,
          apiKey: profile.apiKey || undefined,
        },
      },
    )
    if (requestId !== profile.modelOptionsRequestId) return
    profile.modelOptions = res.models
    profile.modelKeyRequired = !!res.keyRequired
  } catch (err) {
    if (requestId !== profile.modelOptionsRequestId) return
    profile.modelOptions = []
    profile.modelOptionsError = normalizeSettingsError(err, t('settings.llmProvider.modelLoadError'))
  } finally {
    if (requestId === profile.modelOptionsRequestId) profile.modelOptionsPending = false
  }
}

async function loadLlmProfiles(): Promise<void> {
  try {
    const res = await $fetch<LlmProfilesResponse>('/api/settings/llm-profiles')
    llmProfiles.value = res.profiles.map((profile) => makeProfileForm(profile))
    persistedLlmProfileIds.value = new Set(res.profiles.map((profile) => profile.id))
    llmProfileAssignments.extraction = res.assignments.extraction ?? NO_LLM_PROFILE
    llmProfileAssignments.translation = res.assignments.translation ?? NO_LLM_PROFILE
    llmProfileEffective.value = res.effective
    llmProfilesError.value = null
    await Promise.all(llmProfiles.value.map((profile) => loadProfileModelOptions(profile)))
  } catch (err) {
    llmProfilesError.value = normalizeSettingsError(err, t('settings.llmProvider.loadError'))
  }
}

function addLlmProfile(): void {
  llmProfiles.value.push(makeProfileForm({ name: t('settings.llmProvider.newProfileName') }))
  llmProfilesSaved.value = false
}

async function deleteLlmProfile(profile: LlmProviderProfileForm): Promise<void> {
  if (!persistedLlmProfileIds.value.has(profile.id)) {
    llmProfiles.value = llmProfiles.value.filter((candidate) => candidate.id !== profile.id)
    return
  }
  llmProfilesPending.value = true
  llmProfilesError.value = null
  try {
    await $fetch(`/api/settings/llm-profiles/${profile.id}`, { method: 'DELETE' })
    await loadLlmProfiles()
  } catch (err) {
    llmProfilesError.value = normalizeSettingsError(err, t('settings.llmProvider.deleteError'))
  } finally {
    llmProfilesPending.value = false
  }
}

function onLlmProfileProviderChange(profile: LlmProviderProfileForm): void {
  const preset = LLM_PROVIDER_PRESETS[profile.provider]
  profile.baseUrl = preset.baseUrl
  profile.model = preset.model
  if (!profileSupportsBatch(profile)) profile.executionMode = 'sync'
  void loadProfileModelOptions(profile)
}

async function saveLlmProfileList(): Promise<void> {
  llmProfilesPending.value = true
  llmProfilesError.value = null
  llmProfilesSaved.value = false
  try {
    await $fetch('/api/settings/llm-profiles', {
      method: 'PUT',
      body: {
        profiles: llmProfiles.value.map((profile) => ({
          id: profile.id,
          name: profile.name.trim() || profile.provider,
          provider: profile.provider,
          baseUrl: profile.baseUrl.trim(),
          model: profile.model.trim(),
          executionMode: profile.executionMode === 'batch' && profileCanSelectBatch(profile) ? 'batch' : 'sync',
          ...(profile.clearApiKey ? { apiKey: '' } : profile.apiKey ? { apiKey: profile.apiKey } : {}),
        })),
      },
    })
    await loadLlmProfiles()
    llmProfilesSaved.value = !llmProfilesError.value
  } catch (err) {
    llmProfilesError.value = normalizeSettingsError(err, t('settings.llmProvider.saveError'))
  } finally {
    llmProfilesPending.value = false
  }
}

async function saveLlmAssignments(): Promise<void> {
  llmAssignmentsPending.value = true
  llmAssignmentsError.value = null
  llmAssignmentsSaved.value = false
  try {
    await $fetch('/api/settings/llm-assignments', {
      method: 'PUT',
      body: {
        assignments: {
          extraction: llmProfileAssignments.extraction === NO_LLM_PROFILE ? undefined : llmProfileAssignments.extraction,
          translation: llmProfileAssignments.translation === NO_LLM_PROFILE ? undefined : llmProfileAssignments.translation,
        },
      },
    })
    await loadLlmProfiles()
    llmAssignmentsSaved.value = !llmAssignmentsError.value
  } catch (err) {
    llmAssignmentsError.value = normalizeSettingsError(err, t('settings.llmAssignment.saveError'))
  } finally {
    llmAssignmentsPending.value = false
  }
}

// Reprocess-Testlauf: begrenzter Testlauf gegen /api/settings/reprocess
// (server/tasks/reprocess.ts), um eine neue LLM-Provider/Modell-Konfiguration
// gegen eine Handvoll archivierter Auktionen zu verifizieren, bevor der
// volle Bestand neu verarbeitet wird. Zahleneingabe als String + manuelles
// Parsen beim Absenden, gleiches Muster wie llmConfig oben.
interface ReprocessResult {
  candidates: number
  processed: number
  skipped: number
  llmCalls: number
  llmErrors: number
  warning?: string | null
  lastLlmError?: string | null
}
interface LlmBatchJobOverviewItem {
  jobName: string
  source: 'enrich' | 'reprocess'
  status: 'pending' | 'succeeded' | 'failed' | 'expired'
  provider: 'anthropic' | 'gemini' | 'openai'
  itemCount: number
  pendingCount: number
  requestKeys: string[]
  submittedAt: string
  checkedAt: string | null
  updatedAt: string
  errorMessage: string | null
}
interface LlmBatchCapability {
  ok: boolean
  message: string | null
  checkedAt: string
  source: 'enrich' | 'reprocess' | 'config'
}
interface TaskRunStatus {
  status: 'idle' | 'running'
  startedAt: string | null
  finishedAt: string | null
  // Generic — enrichStatus and reprocessStatus report differently shaped
  // summaries (see server/utils/task-runs.ts's TaskRunSummary).
  lastResult: Record<string, number> | null
  lastError: string | null
  lastWarning: string | null
  lastLlmError: string | null
  progress: Record<string, number> | null
}
interface LlmBatchJobsOverview {
  totalJobs: number
  totalRequests: number
  backlog: {
    readyRequests: number
    lowConfidenceRules: number
    missingLlmFields: number
    orphanedBatchMarkers: number
    failedLimit: number
    sampleRequestKeys: string[]
    orphanedRequestKeys: string[]
  }
  jobs: LlmBatchJobOverviewItem[]
  recentJobs: LlmBatchJobOverviewItem[]
  capabilities: Record<string, LlmBatchCapability>
  reprocessStatus: TaskRunStatus
  enrichStatus: TaskRunStatus
}
const reprocessLimit = ref('10')
const reprocessCountry = ref('')
const reprocessBatch = ref(false)
const reprocessPending = ref(false)
const reprocessError = ref<string | null>(null)
const reprocessResult = ref<ReprocessResult | null>(null)
const llmBatchJobs = ref<LlmBatchJobsOverview | null>(null)
const llmBatchJobsPending = ref(false)
const llmBatchJobsError = ref<string | null>(null)

function formatBatchDate(iso: string | null): string {
  if (!iso) return '–'
  const date = new Date(iso)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : iso
}

const llmBatchBacklog = computed(() => llmBatchJobs.value?.backlog ?? {
  readyRequests: 0,
  lowConfidenceRules: 0,
  missingLlmFields: 0,
  orphanedBatchMarkers: 0,
  failedLimit: 0,
  sampleRequestKeys: [],
  orphanedRequestKeys: [],
})

async function loadLlmBatchJobs(): Promise<void> {
  llmBatchJobsPending.value = true
  llmBatchJobsError.value = null
  try {
    llmBatchJobs.value = await $fetch<LlmBatchJobsOverview>('/api/settings/llm-batch-jobs', { cache: 'no-store' })
    // Covers a page load/login while the global cron (or another tab's
    // manual trigger) is already running — not just this tab's own click.
    if (llmBatchJobs.value.enrichStatus.status === 'running' || llmBatchJobs.value.reprocessStatus.status === 'running') {
      startProgressPolling()
    }
  } catch (err) {
    llmBatchJobsError.value = normalizeSettingsError(err, t('settings.llmBatch.loadError'))
  } finally {
    llmBatchJobsPending.value = false
  }
}

function parseReprocessLimit(raw: string): number | null {
  const value = Number(raw)
  return Number.isInteger(value) && value >= 1 && value <= 200 ? value : null
}

async function runReprocessTest(): Promise<void> {
  const limit = parseReprocessLimit(reprocessLimit.value)
  if (limit === null) {
    reprocessError.value = t('settings.reprocess.invalidLimit')
    return
  }
  reprocessPending.value = true
  reprocessError.value = null
  reprocessResult.value = null
  try {
    reprocessResult.value = await $fetch<ReprocessResult>('/api/settings/reprocess', {
      method: 'POST',
      body: {
        limit,
        country: reprocessCountry.value.trim() || undefined,
        batch: reprocessBatch.value || undefined,
      },
    })
    await loadLlmBatchJobs()
  } catch (err) {
    reprocessError.value = normalizeSettingsError(err, t('settings.reprocess.runError'))
  } finally {
    reprocessPending.value = false
  }
}

// Datenquellen: persistent aktivierte Länder-Crawler. Die Registry setzt eine
// gespeicherte Änderung sofort um. enrichCountrySource fragt die Originalquelle
// erneut ab, füllt Cache/Roharchiv und stößt anschließend die Extraktion für
// nur dieses Land an. Optional erzwingt die UI Checkbox die Extraktion auch
// gegen unveränderte, bereits geparste Rohdaten.
interface EnrichRunResult {
  crawled: number
  todo: number
  archived: number
  enriched: number
  photoExtractions: number
  photosTotal: number
  durationMs: number
  externalEnrichmentQueued?: boolean
}
const countrySources = ref<CountrySourceSetting[]>([])
const countrySourcesPending = ref(false)
const countrySourcesError = ref<string | null>(null)
const countrySourcesSaved = ref(false)
const countrySourcesLoaded = ref(false)
const countryEnrichPending = ref<string | null>(null)
const countryEnrichError = ref<string | null>(null)
const countryEnrichResult = ref<EnrichRunResult & { country: string } | null>(null)
const forceCountryExtraction = ref(false)
const enabledCountrySourceCount = computed(
  () => countrySources.value.filter((source) => source.enabled).length,
)

async function loadCountrySources(): Promise<void> {
  try {
    const res = await $fetch<CountrySourceSettings>('/api/settings/countries')
    countrySources.value = res.countries
    countrySourcesLoaded.value = true
    countrySourcesError.value = null
  } catch (err) {
    countrySourcesLoaded.value = false
    countrySourcesError.value = normalizeSettingsError(err, t('settings.sources.loadError'))
  }
}

function toggleCountrySource(code: string): void {
  const source = countrySources.value.find((candidate) => candidate.code === code)
  if (source) source.enabled = !source.enabled
  countrySourcesSaved.value = false
}

async function saveCountrySources(): Promise<void> {
  if (!countrySourcesLoaded.value) return
  countrySourcesPending.value = true
  countrySourcesError.value = null
  countrySourcesSaved.value = false
  try {
    const res = await $fetch<CountrySourceSettings>('/api/settings/countries', {
      method: 'PUT',
      body: {
        enabledCountries: countrySources.value
          .filter((source) => source.enabled)
          .map((source) => source.code),
      },
    })
    countrySources.value = res.countries
    countrySourcesSaved.value = true
  } catch (err) {
    countrySourcesError.value = normalizeSettingsError(err, t('settings.sources.saveError'))
  } finally {
    countrySourcesPending.value = false
  }
}

// Separate from `pollTimer` above (the Claude-OAuth-Flow poll) — polls the
// enrich/reprocess task status every 3s while either is running, so both the
// global hourly cron run and a manual per-country click show live progress.
// Always refreshes first, then decides whether to keep going, since polling
// can start (right after a click) before the freshly triggered run's
// 'running' status has even been fetched once.
let progressPollTimer: ReturnType<typeof setInterval> | null = null
function startProgressPolling(): void {
  if (progressPollTimer) return
  progressPollTimer = setInterval(async () => {
    await loadLlmBatchJobs()
    const running = llmBatchJobs.value?.enrichStatus.status === 'running'
      || llmBatchJobs.value?.reprocessStatus.status === 'running'
    if (!running) stopProgressPolling()
  }, 3000)
}
function stopProgressPolling(): void {
  if (progressPollTimer) {
    clearInterval(progressPollTimer)
    progressPollTimer = null
  }
}

async function enrichCountrySource(source: CountrySourceSetting): Promise<void> {
  if (!source.enabled || countryEnrichPending.value) return

  countryEnrichPending.value = source.code
  countryEnrichError.value = null
  countryEnrichResult.value = null
  startProgressPolling()
  try {
    const res = await $fetch<{ result: EnrichRunResult }>(
      `/api/settings/countries/${source.code}/enrich`,
      {
        method: 'POST',
        body: { forceExtraction: forceCountryExtraction.value },
      },
    )
    countryEnrichResult.value = { ...res.result, country: source.code }
    await loadLlmBatchJobs()
  } catch (err) {
    countryEnrichError.value = normalizeSettingsError(err, t('settings.sources.enrichError'))
  } finally {
    countryEnrichPending.value = null
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

// Externe Datenquellen: generische Karte über die configFields aus
// server/utils/external-data/sources.ts — jede Quelle, die welche deklariert,
// taucht hier automatisch mit ihren Feldern auf, ohne dass diese Datei sie
// namentlich kennen muss. Ein leeres Feld beim Speichern löscht den
// DB-Override und fällt zurück auf Env/Default (effectiveValue zeigt, was
// dann aktiv wird).
interface ExternalDataSourceField {
  key: string
  type: 'url' | 'path' | 'number'
  envVar: string
  required: boolean
  storedValue: string | number | null
  effectiveValue: string | number
}
interface ExternalDataSourceSetting {
  id: string
  label: string
  sourceUrl: string
  licenseNote: string
  isConfigured: boolean
  fields: ExternalDataSourceField[]
}
const externalDataSources = ref<ExternalDataSourceSetting[]>([])
const externalDataSourcesLoaded = ref(false)
const externalDataSourcesError = ref<string | null>(null)
const externalDataSourcePending = ref<string | null>(null)
const externalDataSourceSaved = ref<string | null>(null)
const externalDataFieldDrafts = reactive<Record<string, string>>({})

function externalDataDraftKey(sourceId: string, fieldKey: string): string {
  return `${sourceId}:${fieldKey}`
}

async function loadExternalDataSources(): Promise<void> {
  try {
    const res = await $fetch<{ sources: ExternalDataSourceSetting[] }>('/api/settings/external-data/sources')
    externalDataSources.value = res.sources
    for (const source of res.sources) {
      for (const field of source.fields) {
        externalDataFieldDrafts[externalDataDraftKey(source.id, field.key)] = field.storedValue != null ? String(field.storedValue) : ''
      }
    }
    externalDataSourcesLoaded.value = true
    externalDataSourcesError.value = null
  } catch (err) {
    externalDataSourcesLoaded.value = false
    externalDataSourcesError.value = normalizeSettingsError(err, t('settings.externalData.loadError'))
  }
}

async function saveExternalDataSource(source: ExternalDataSourceSetting): Promise<void> {
  if (!externalDataSourcesLoaded.value) return
  externalDataSourcePending.value = source.id
  externalDataSourceSaved.value = null
  externalDataSourcesError.value = null
  try {
    const body: Record<string, string> = {}
    for (const field of source.fields) {
      body[field.key] = externalDataFieldDrafts[externalDataDraftKey(source.id, field.key)] ?? ''
    }
    await $fetch(`/api/settings/external-data/sources/${source.id}`, { method: 'PUT', body })
    await loadExternalDataSources()
    externalDataSourceSaved.value = source.id
  } catch (err) {
    externalDataSourcesError.value = normalizeSettingsError(err, t('settings.externalData.saveError'))
  } finally {
    externalDataSourcePending.value = null
  }
}

onMounted(probeSession)
onBeforeUnmount(stopPolling)
onBeforeUnmount(stopProgressPolling)
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

          <form class="grid grid-cols-1 sm:grid-cols-2 gap-3" @submit.prevent="saveLlmConfig">
            <div v-for="kind in Object.keys(llmConfig)" :key="kind" class="space-y-1">
              <Label>{{ llmKindLabel(kind) }}</Label>
              <Input v-model="llmConfig[kind]" type="number" min="256" max="32768" step="1" />
            </div>
            <div class="sm:col-span-2">
              <Button type="submit" :disabled="llmConfigSaveDisabled">
                {{ llmConfigPending ? $t('settings.llm.saving') : $t('settings.llm.save') }}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card v-if="authed">
        <CardHeader>
          <CardTitle>{{ $t('settings.llmProvider.title') }}</CardTitle>
          <CardAction>
            <Button type="button" size="sm" @click="addLlmProfile">{{ $t('settings.llmProvider.addProfile') }}</Button>
          </CardAction>
        </CardHeader>
        <CardContent class="space-y-6">
          <p class="text-sm text-muted-foreground">
            {{ $t('settings.llmProvider.description') }}
          </p>

          <p v-if="llmProfilesError" class="text-sm text-destructive">{{ llmProfilesError }}</p>
          <p v-if="llmProfilesSaved" class="text-sm text-emerald-600 dark:text-emerald-500">{{ $t('settings.llmProvider.saved') }}</p>

          <div class="space-y-4">
            <p v-if="!llmProfiles.length" class="text-sm text-muted-foreground">
              {{ $t('settings.llmProvider.profilesEmpty') }}
            </p>

            <div v-for="profile in llmProfiles" :key="profile.id" class="space-y-3 rounded-md border p-3">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div class="space-y-1">
                  <Label>{{ $t('settings.llmProvider.profileNameLabel') }}</Label>
                  <Input v-model="profile.name" />
                </div>
                <div class="space-y-1">
                  <Label>{{ $t('settings.llmProvider.providerLabel') }}</Label>
                  <Select v-model="profile.provider" @update:model-value="onLlmProfileProviderChange(profile)">
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
                <div class="space-y-1">
                  <Label>{{ $t('settings.llmProvider.baseUrlLabel') }}</Label>
                  <Input v-model="profile.baseUrl" />
                </div>
                <div class="space-y-1">
                  <Label>{{ $t('settings.llmProvider.modelLabel') }}</Label>
                  <Input v-if="profile.provider === 'openai-compatible'" v-model="profile.model" />
                  <div v-else class="flex gap-2">
                    <Select v-model="profile.model" :disabled="profile.modelOptionsPending || !profile.modelOptions.length">
                      <SelectTrigger class="w-full">
                        <SelectValue
                          :placeholder="profile.modelOptionsPending ? $t('settings.llmProvider.modelLoading') : $t('settings.llmProvider.modelSelectPlaceholder')"
                        />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem v-for="opt in profile.modelOptions" :key="opt.id" :value="opt.id">{{ opt.label }}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button type="button" variant="outline" :disabled="profile.modelOptionsPending" @click="loadProfileModelOptions(profile)">
                      {{ $t('settings.llmProvider.modelRefresh') }}
                    </Button>
                  </div>
                  <p v-if="profile.modelKeyRequired" class="text-xs text-muted-foreground">{{ $t('settings.llmProvider.modelKeyRequired') }}</p>
                  <p v-if="profile.modelOptionsError" class="text-xs text-destructive">{{ profile.modelOptionsError }}</p>
                </div>
              </div>

              <div class="space-y-1">
                <Label>{{ $t('settings.llmProvider.executionModeLabel') }}</Label>
                <Select v-model="profile.executionMode">
                  <SelectTrigger class="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sync">{{ $t('settings.llmProvider.executionModeSync') }}</SelectItem>
                    <SelectItem v-if="profileSupportsBatch(profile)" value="batch" :disabled="!profileCanSelectBatch(profile)">
                      {{ $t('settings.llmProvider.executionModeBatch') }}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p v-if="!profileSupportsBatch(profile)" class="text-xs text-muted-foreground">
                  {{ $t('settings.llmProvider.batchUnsupported') }}
                </p>
                <p v-else-if="providerCapability(profile.provider)?.source === 'config'" class="text-xs text-destructive">
                  {{ $t('settings.llmProvider.batchConfigGated') }}
                </p>
                <p v-else-if="providerBatchBroken(profile.provider)" class="text-xs text-destructive">
                  {{ $t('settings.llmProvider.batchBroken', { message: providerCapability(profile.provider)?.message ?? '' }) }}
                </p>
              </div>

              <div class="space-y-1">
                <Label>{{ $t('settings.llmProvider.apiKeyLabel') }}</Label>
                <Input
                  v-model="profile.apiKey"
                  type="password"
                  autocomplete="off"
                  :placeholder="profile.apiKeySet ? $t('settings.llmProvider.apiKeyPlaceholderSet') : $t('settings.llmProvider.apiKeyPlaceholderUnset')"
                />
                <Label v-if="profile.apiKeySet" class="flex items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox v-model="profile.clearApiKey" />
                  {{ $t('settings.llmProvider.apiKeyClearOnSave') }}
                </Label>
                <p v-if="profile.apiKeyMissing && !profile.apiKey.trim()" class="text-xs text-destructive">
                  {{ $t('settings.llmProvider.apiKeyMissing') }}
                </p>
              </div>

              <div class="flex justify-end">
                <Button type="button" variant="ghost" class="hover:text-destructive" :disabled="llmProfilesPending" @click="deleteLlmProfile(profile)">
                  <Trash2 class="h-4 w-4" />
                  {{ $t('settings.llmProvider.removeProfile') }}
                </Button>
              </div>
            </div>
          </div>

          <div class="flex flex-wrap gap-2">
            <Button type="button" :disabled="llmProfilesPending" @click="saveLlmProfileList">
              {{ llmProfilesPending ? $t('settings.llmProvider.saving') : $t('settings.llmProvider.save') }}
            </Button>
          </div>

          <div
            v-if="llmProfiles.some((profile) => profile.provider === 'claude-proxy')"
            class="border-t pt-4 space-y-4"
          >
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
          <CardTitle>{{ $t('settings.llmAssignment.title') }}</CardTitle>
        </CardHeader>
        <CardContent class="space-y-6">
          <p class="text-sm text-muted-foreground">
            {{ $t('settings.llmAssignment.description') }}
          </p>

          <p v-if="llmAssignmentsError" class="text-sm text-destructive">{{ llmAssignmentsError }}</p>
          <p v-if="llmAssignmentsSaved" class="text-sm text-emerald-600 dark:text-emerald-500">{{ $t('settings.llmAssignment.saved') }}</p>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div v-for="scope in LLM_PROVIDER_SCOPES" :key="scope" class="space-y-1">
              <Label>
                {{ scope === 'translation' ? $t('settings.llmAssignment.translationTitle') : $t('settings.llmAssignment.extractionTitle') }}
              </Label>
              <Select v-model="llmProfileAssignments[scope]">
                <SelectTrigger class="w-full">
                  <SelectValue :placeholder="$t('settings.llmAssignment.noProfileAssigned')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem :value="NO_LLM_PROFILE">{{ $t('settings.llmAssignment.noProfileAssigned') }}</SelectItem>
                  <SelectItem v-for="profile in llmProfiles" :key="profile.id" :value="profile.id">
                    {{ profile.name || profile.model }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p v-if="llmProfileAssignments[scope] === NO_LLM_PROFILE && llmProfileEffective" class="text-xs text-muted-foreground">
                {{ $t(scope === 'translation' ? 'settings.llmAssignment.usingTranslationFallback' : 'settings.llmAssignment.usingEnvDefault', {
                  provider: llmProfileEffective[scope].provider,
                  baseUrl: llmProfileEffective[scope].baseUrl,
                }) }}
              </p>
            </div>
          </div>

          <div class="flex flex-wrap gap-2">
            <Button type="button" :disabled="llmAssignmentsPending" @click="saveLlmAssignments">
              {{ llmAssignmentsPending ? $t('settings.llmAssignment.saving') : $t('settings.llmAssignment.save') }}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card v-if="authed">
        <CardHeader>
          <div class="flex items-center justify-between gap-3">
            <CardTitle>{{ $t('settings.llmBatch.title') }}</CardTitle>
            <Button type="button" variant="outline" size="sm" :disabled="llmBatchJobsPending" @click="loadLlmBatchJobs">
              <RefreshCw class="h-4 w-4" :class="{ 'animate-spin': llmBatchJobsPending }" />
              {{ $t('settings.llmBatch.refresh') }}
            </Button>
          </div>
        </CardHeader>
        <CardContent class="space-y-4">
          <p class="text-sm text-muted-foreground">
            {{ $t('settings.llmBatch.description') }}
          </p>
          <p v-if="llmBatchJobsError" class="text-sm text-destructive">{{ llmBatchJobsError }}</p>

          <div v-if="llmBatchJobs?.reprocessStatus" class="text-sm space-y-1">
            <p v-if="llmBatchJobs.reprocessStatus.status === 'running'">
              {{ $t('settings.llmBatch.reprocessRunning', { at: formatBatchDate(llmBatchJobs.reprocessStatus.startedAt) }) }}
            </p>
            <p v-else-if="llmBatchJobs.reprocessStatus.finishedAt" class="text-muted-foreground">
              {{ $t('settings.llmBatch.reprocessLastRun', {
                at: formatBatchDate(llmBatchJobs.reprocessStatus.finishedAt),
                processed: llmBatchJobs.reprocessStatus.lastResult?.processed ?? 0,
                llmCalls: llmBatchJobs.reprocessStatus.lastResult?.llmCalls ?? 0,
                duration: Math.round((llmBatchJobs.reprocessStatus.lastResult?.durationMs ?? 0) / 1000),
              }) }}
            </p>
            <p v-if="llmBatchJobs.reprocessStatus.lastError" class="text-destructive">
              {{ $t('settings.llmBatch.reprocessLastError', { message: llmBatchJobs.reprocessStatus.lastError }) }}
            </p>
            <p v-if="llmBatchJobs.reprocessStatus.lastWarning" class="text-amber-600 dark:text-amber-400">
              {{ $t('settings.llmBatch.reprocessLastWarning', { message: llmBatchJobs.reprocessStatus.lastWarning }) }}
            </p>
            <p v-if="llmBatchJobs.reprocessStatus.lastResult?.llmErrors" class="text-destructive">
              {{ $t('settings.llmBatch.reprocessLlmErrors', { count: llmBatchJobs.reprocessStatus.lastResult.llmErrors }) }}
            </p>
            <p v-if="llmBatchJobs.reprocessStatus.lastLlmError" class="text-destructive">
              {{ $t('settings.llmBatch.reprocessLastLlmError', { message: llmBatchJobs.reprocessStatus.lastLlmError }) }}
            </p>
          </div>

          <div class="grid grid-cols-2 gap-3 text-sm">
            <div class="border rounded-md p-3">
              <div class="text-xs text-muted-foreground">{{ $t('settings.llmBatch.totalJobs') }}</div>
              <div class="text-xl font-semibold tabular-nums">{{ llmBatchJobs?.totalJobs ?? 0 }}</div>
            </div>
            <div class="border rounded-md p-3">
              <div class="text-xs text-muted-foreground">{{ $t('settings.llmBatch.totalRequests') }}</div>
              <div class="text-xl font-semibold tabular-nums">{{ llmBatchJobs?.totalRequests ?? 0 }}</div>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div class="border rounded-md p-3">
              <div class="text-xs text-muted-foreground">{{ $t('settings.llmBatch.readyRequests') }}</div>
              <div class="text-xl font-semibold tabular-nums">{{ llmBatchBacklog.readyRequests }}</div>
            </div>
            <div class="border rounded-md p-3">
              <div class="text-xs text-muted-foreground">{{ $t('settings.llmBatch.lowConfidenceRules') }}</div>
              <div class="text-xl font-semibold tabular-nums">{{ llmBatchBacklog.lowConfidenceRules }}</div>
            </div>
            <div class="border rounded-md p-3">
              <div class="text-xs text-muted-foreground">{{ $t('settings.llmBatch.missingLlmFields') }}</div>
              <div class="text-xl font-semibold tabular-nums">{{ llmBatchBacklog.missingLlmFields }}</div>
            </div>
            <div class="border rounded-md p-3">
              <div class="text-xs text-muted-foreground">{{ $t('settings.llmBatch.orphanedBatchMarkers') }}</div>
              <div class="text-xl font-semibold tabular-nums">{{ llmBatchBacklog.orphanedBatchMarkers }}</div>
            </div>
          </div>

          <p v-if="llmBatchBacklog.failedLimit > 0" class="text-sm text-muted-foreground">
            {{ $t('settings.llmBatch.failedLimit', { count: llmBatchBacklog.failedLimit }) }}
          </p>

          <div v-if="llmBatchBacklog.sampleRequestKeys.length" class="space-y-2">
            <div class="text-sm font-medium">{{ $t('settings.llmBatch.readySample') }}</div>
            <div class="max-h-32 overflow-auto rounded border bg-muted/30 p-2">
              <div v-for="key in llmBatchBacklog.sampleRequestKeys" :key="`ready:${key}`" class="font-mono text-xs leading-6">
                {{ key }}
              </div>
            </div>
          </div>

          <div v-if="llmBatchBacklog.orphanedRequestKeys.length" class="space-y-2">
            <div class="text-sm font-medium">{{ $t('settings.llmBatch.orphanedSample') }}</div>
            <div class="max-h-32 overflow-auto rounded border bg-muted/30 p-2">
              <div v-for="key in llmBatchBacklog.orphanedRequestKeys" :key="`orphaned:${key}`" class="font-mono text-xs leading-6">
                {{ key }}
              </div>
            </div>
          </div>

          <p v-if="!llmBatchJobsPending && (!llmBatchJobs || llmBatchJobs.jobs.length === 0)" class="text-sm text-muted-foreground">
            {{ $t('settings.llmBatch.empty') }}
          </p>

          <div v-if="llmBatchJobs?.jobs.length" class="space-y-3">
            <div class="text-sm font-medium">{{ $t('settings.llmBatch.openHeading') }}</div>
          </div>
          <div v-for="job in llmBatchJobs?.jobs ?? []" :key="job.jobName" class="border rounded-md p-3 space-y-3">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="font-mono text-xs break-all">{{ job.jobName }}</div>
                <div class="mt-1 flex flex-wrap gap-2">
                  <Badge variant="secondary">{{ job.provider }}</Badge>
                  <Badge variant="outline">{{ $t(`settings.llmBatch.source.${job.source}`) }}</Badge>
                  <Badge variant="outline">{{ $t(`settings.llmBatch.status.${job.status}`) }}</Badge>
                </div>
              </div>
              <div class="text-right text-sm">
                <div class="font-semibold tabular-nums">
                  {{ $t('settings.llmBatch.pendingOfTotal', { pending: job.pendingCount, total: job.itemCount }) }}
                </div>
                <div class="text-xs text-muted-foreground">
                  {{ $t('settings.llmBatch.submittedAt', { at: formatBatchDate(job.submittedAt) }) }}
                </div>
              </div>
            </div>

            <div v-if="job.requestKeys.length" class="max-h-40 overflow-auto rounded border bg-muted/30 p-2">
              <div v-for="key in job.requestKeys" :key="`${job.jobName}:${key}`" class="font-mono text-xs leading-6">
                {{ key }}
              </div>
            </div>
          </div>

          <div v-if="llmBatchJobs?.recentJobs.length" class="space-y-3">
            <div class="text-sm font-medium">{{ $t('settings.llmBatch.historyHeading') }}</div>
            <div v-for="job in llmBatchJobs.recentJobs" :key="`recent:${job.jobName}`" class="border rounded-md p-3 space-y-2">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="font-mono text-xs break-all">{{ job.jobName }}</div>
                  <div class="mt-1 flex flex-wrap gap-2">
                    <Badge variant="secondary">{{ job.provider }}</Badge>
                    <Badge variant="outline">{{ $t(`settings.llmBatch.source.${job.source}`) }}</Badge>
                    <Badge variant="outline">{{ $t(`settings.llmBatch.status.${job.status}`) }}</Badge>
                  </div>
                </div>
                <div class="text-right text-sm">
                  <div class="font-semibold tabular-nums">
                    {{ $t('settings.llmBatch.itemsTotal', { total: job.itemCount }) }}
                  </div>
                  <div class="text-xs text-muted-foreground">
                    {{ $t('settings.llmBatch.updatedAt', { at: formatBatchDate(job.updatedAt) }) }}
                  </div>
                </div>
              </div>
              <p v-if="job.errorMessage" class="text-sm text-destructive">{{ job.errorMessage }}</p>
              <div v-if="job.requestKeys.length" class="max-h-28 overflow-auto rounded border bg-muted/30 p-2">
                <div v-for="key in job.requestKeys" :key="`recent:${job.jobName}:${key}`" class="font-mono text-xs leading-6">
                  {{ key }}
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card v-if="authed">
        <CardHeader>
          <CardTitle>{{ $t('settings.reprocess.title') }}</CardTitle>
        </CardHeader>
        <CardContent class="space-y-4">
          <p class="text-sm text-muted-foreground">
            {{ $t('settings.reprocess.description') }}
          </p>

          <p v-if="reprocessError" class="text-sm text-destructive">{{ reprocessError }}</p>

          <form class="space-y-3" @submit.prevent="runReprocessTest">
            <div class="grid grid-cols-2 gap-3">
              <div class="space-y-1">
                <Label>{{ $t('settings.reprocess.limitLabel') }}</Label>
                <Input v-model="reprocessLimit" type="number" min="1" max="200" step="1" />
              </div>
              <div class="space-y-1">
                <Label>{{ $t('settings.reprocess.countryLabel') }}</Label>
                <Input v-model="reprocessCountry" />
              </div>
            </div>
            <label class="flex items-center gap-2 text-sm">
              <Checkbox v-model="reprocessBatch" />
              {{ $t('settings.reprocess.batchLabel') }}
            </label>
            <Button type="submit" :disabled="reprocessPending">
              {{ reprocessPending ? $t('settings.reprocess.running') : $t('settings.reprocess.run') }}
            </Button>
          </form>

          <dl v-if="reprocessResult" class="grid grid-cols-2 gap-x-4 gap-y-1 text-sm border-t pt-3">
            <dt class="text-muted-foreground">{{ $t('settings.reprocess.candidates') }}</dt>
            <dd>{{ reprocessResult.candidates }}</dd>
            <dt class="text-muted-foreground">{{ $t('settings.reprocess.processed') }}</dt>
            <dd>{{ reprocessResult.processed }}</dd>
            <dt class="text-muted-foreground">{{ $t('settings.reprocess.skipped') }}</dt>
            <dd>{{ reprocessResult.skipped }}</dd>
            <dt class="text-muted-foreground">{{ $t('settings.reprocess.llmCalls') }}</dt>
            <dd>{{ reprocessResult.llmCalls }}</dd>
            <dt class="text-muted-foreground">{{ $t('settings.reprocess.llmErrors') }}</dt>
            <dd>{{ reprocessResult.llmErrors }}</dd>
          </dl>
          <p v-if="reprocessResult?.warning" class="text-sm text-amber-600 dark:text-amber-400">
            {{ $t('settings.reprocess.warning', { message: reprocessResult.warning }) }}
          </p>
          <p v-if="reprocessResult?.lastLlmError" class="text-sm text-destructive">
            {{ $t('settings.reprocess.lastLlmError', { message: reprocessResult.lastLlmError }) }}
          </p>
        </CardContent>
      </Card>

      <Card v-if="authed">
        <CardHeader>
          <CardTitle>{{ $t('settings.sources.title') }}</CardTitle>
        </CardHeader>
        <CardContent class="space-y-4">
          <p class="text-sm text-muted-foreground">
            {{ $t('settings.sources.description') }}
          </p>

          <p v-if="countrySourcesError" class="text-sm text-destructive">{{ countrySourcesError }}</p>
          <p v-if="countryEnrichError" class="text-sm text-destructive">{{ countryEnrichError }}</p>
          <p v-if="countrySourcesSaved" class="text-sm text-emerald-600 dark:text-emerald-500">{{ $t('settings.sources.saved') }}</p>
          <p v-if="countryEnrichResult" class="text-sm text-emerald-600 dark:text-emerald-500">
            {{ $t('settings.sources.enrichDone', {
              country: countryLabel(countryEnrichResult.country),
              archived: countryEnrichResult.archived,
              crawled: countryEnrichResult.crawled,
              photos: countryEnrichResult.photosTotal,
              duration: Math.round(countryEnrichResult.durationMs / 1000),
            }) }}
          </p>
          <p v-if="countryEnrichResult?.externalEnrichmentQueued" class="text-sm text-emerald-600 dark:text-emerald-500">
            {{ $t('settings.sources.externalEnrichmentQueued') }}
          </p>

          <div v-if="llmBatchJobs?.enrichStatus" class="text-sm space-y-1">
            <p v-if="llmBatchJobs.enrichStatus.status === 'running'">
              {{ $t('settings.sources.enrichStatusRunning', { at: formatBatchDate(llmBatchJobs.enrichStatus.startedAt) }) }}
            </p>
            <p v-else-if="llmBatchJobs.enrichStatus.finishedAt" class="text-muted-foreground">
              {{ $t('settings.sources.enrichStatusLastRun', {
                at: formatBatchDate(llmBatchJobs.enrichStatus.finishedAt),
                archived: llmBatchJobs.enrichStatus.lastResult?.archived ?? 0,
                duration: Math.round((llmBatchJobs.enrichStatus.lastResult?.durationMs ?? 0) / 1000),
              }) }}
            </p>
            <p v-if="llmBatchJobs.enrichStatus.status === 'running' && llmBatchJobs.enrichStatus.progress" class="text-muted-foreground">
              {{ $t('settings.sources.enrichStatusProgress', {
                regionsDone: llmBatchJobs.enrichStatus.progress.regionsDone ?? 0,
                regionsTotal: llmBatchJobs.enrichStatus.progress.regionsTotal ?? 0,
                archivedDone: llmBatchJobs.enrichStatus.progress.archivedDone ?? 0,
                archivedTotal: llmBatchJobs.enrichStatus.progress.archivedTotal ?? 0,
              }) }}
            </p>
            <p v-if="llmBatchJobs.enrichStatus.lastError" class="text-destructive">
              {{ $t('settings.sources.enrichStatusLastError', { message: llmBatchJobs.enrichStatus.lastError }) }}
            </p>
          </div>

          <div v-if="llmBatchJobs?.reprocessStatus" class="text-sm space-y-1">
            <p v-if="llmBatchJobs.reprocessStatus.status === 'running'">
              {{ $t('settings.sources.llmStatusRunning', { at: formatBatchDate(llmBatchJobs.reprocessStatus.startedAt) }) }}
            </p>
            <p v-else-if="llmBatchJobs.reprocessStatus.finishedAt" class="text-muted-foreground">
              {{ $t('settings.sources.llmStatusLastRun', {
                at: formatBatchDate(llmBatchJobs.reprocessStatus.finishedAt),
                processed: llmBatchJobs.reprocessStatus.lastResult?.processed ?? 0,
                llmCalls: llmBatchJobs.reprocessStatus.lastResult?.llmCalls ?? 0,
                duration: Math.round((llmBatchJobs.reprocessStatus.lastResult?.durationMs ?? 0) / 1000),
              }) }}
            </p>
            <p v-if="llmBatchJobs.reprocessStatus.status === 'running' && llmBatchJobs.reprocessStatus.progress" class="text-muted-foreground">
              {{ $t('settings.sources.llmStatusProgress', {
                processed: llmBatchJobs.reprocessStatus.progress.processed ?? 0,
                candidatesTotal: llmBatchJobs.reprocessStatus.progress.candidatesTotal ?? 0,
                llmCalls: llmBatchJobs.reprocessStatus.progress.llmCalls ?? 0,
                skipped: llmBatchJobs.reprocessStatus.progress.skipped ?? 0,
              }) }}
            </p>
            <p v-if="llmBatchJobs.reprocessStatus.lastWarning" class="text-amber-600 dark:text-amber-400">
              {{ $t('settings.sources.llmStatusLastWarning', { message: llmBatchJobs.reprocessStatus.lastWarning }) }}
            </p>
            <p v-if="llmBatchJobs.reprocessStatus.lastError" class="text-destructive">
              {{ $t('settings.sources.llmStatusLastError', { message: llmBatchJobs.reprocessStatus.lastError }) }}
            </p>
            <p v-if="llmBatchJobs.reprocessStatus.lastResult?.llmErrors" class="text-destructive">
              {{ $t('settings.sources.llmStatusLlmErrors', { count: llmBatchJobs.reprocessStatus.lastResult.llmErrors }) }}
            </p>
            <p v-if="llmBatchJobs.reprocessStatus.lastLlmError" class="text-destructive">
              {{ $t('settings.sources.llmStatusLastLlmError', { message: llmBatchJobs.reprocessStatus.lastLlmError }) }}
            </p>
          </div>

          <form class="space-y-3" @submit.prevent="saveCountrySources">
            <label class="flex items-start gap-2 rounded-md border bg-muted/20 p-3 text-sm">
              <Checkbox v-model="forceCountryExtraction" class="mt-0.5" :disabled="countryEnrichPending !== null" />
              <span class="space-y-1">
                <span class="block font-medium">{{ $t('settings.sources.forceExtraction') }}</span>
                <span class="block text-xs text-muted-foreground">{{ $t('settings.sources.forceExtractionHelp') }}</span>
              </span>
            </label>

            <div class="max-h-80 overflow-y-auto rounded-md border divide-y">
              <div
                v-for="source in countrySources"
                :key="source.code"
                class="flex items-start gap-3 px-3 py-2.5 hover:bg-muted/50"
              >
                <Checkbox
                  class="mt-0.5"
                  :model-value="source.enabled"
                  :disabled="countrySourcesPending"
                  @update:model-value="toggleCountrySource(source.code)"
                />
                <button
                  type="button"
                  class="min-w-0 flex-1 text-left disabled:cursor-not-allowed disabled:opacity-60"
                  :disabled="countrySourcesPending"
                  @click="toggleCountrySource(source.code)"
                >
                  <span class="block text-sm font-medium">
                    {{ countryLabel(source.code, source.name) }}
                    <span class="ml-1 font-mono text-xs uppercase text-muted-foreground">{{ source.code }}</span>
                  </span>
                  <span class="block text-xs text-muted-foreground">
                    {{ source.platforms.map((platform) => platform.name).join(', ') }}
                  </span>
                </button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  class="shrink-0"
                  :title="$t('settings.sources.enrichTitle')"
                  :disabled="!source.enabled || countrySourcesPending || countryEnrichPending !== null"
                  @click="enrichCountrySource(source)"
                >
                  <Loader2 v-if="countryEnrichPending === source.code" class="h-4 w-4 animate-spin" />
                  <RefreshCw v-else class="h-4 w-4" />
                  {{ countryEnrichPending === source.code ? $t('settings.sources.enriching') : $t('settings.sources.enrich') }}
                </Button>
              </div>
            </div>

            <p class="text-xs text-muted-foreground">
              {{ $t('settings.sources.enabledCount', {
                enabled: enabledCountrySourceCount,
                total: countrySources.length,
              }) }}
            </p>

            <Button type="submit" :disabled="countrySourcesPending || !countrySourcesLoaded">
              {{ countrySourcesPending ? $t('settings.sources.saving') : $t('settings.sources.save') }}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card v-if="authed">
        <CardHeader>
          <CardTitle>{{ $t('settings.externalData.title') }}</CardTitle>
        </CardHeader>
        <CardContent class="space-y-4">
          <p class="text-sm text-muted-foreground">{{ $t('settings.externalData.description') }}</p>
          <p v-if="externalDataSourcesError" class="text-sm text-destructive">{{ externalDataSourcesError }}</p>

          <div
            v-for="source in externalDataSources"
            :key="source.id"
            class="space-y-3 rounded-md border p-3"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="text-sm font-medium">{{ source.label }}</p>
                <p class="text-xs text-muted-foreground">{{ source.licenseNote }}</p>
                <a
                  :href="source.sourceUrl"
                  target="_blank"
                  rel="noopener"
                  class="text-xs underline underline-offset-2 hover:text-foreground"
                >
                  {{ source.sourceUrl }}
                </a>
              </div>
              <Badge
                variant="outline"
                :class="source.isConfigured
                  ? 'shrink-0 text-emerald-600 dark:text-emerald-500 border-emerald-600/40'
                  : 'shrink-0 text-muted-foreground'"
              >
                {{ source.isConfigured ? $t('settings.externalData.configured') : $t('settings.externalData.notConfigured') }}
              </Badge>
            </div>

            <div class="grid gap-3 sm:grid-cols-2">
              <div v-for="field in source.fields" :key="field.key" class="space-y-1">
                <label class="block text-xs font-medium text-muted-foreground">{{ field.envVar }}</label>
                <Input
                  v-model="externalDataFieldDrafts[`${source.id}:${field.key}`]"
                  :type="field.type === 'number' ? 'number' : 'text'"
                  :placeholder="String(field.effectiveValue)"
                />
              </div>
            </div>

            <div class="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                :disabled="externalDataSourcePending === source.id || !externalDataSourcesLoaded"
                @click="saveExternalDataSource(source)"
              >
                {{ externalDataSourcePending === source.id ? $t('settings.externalData.saving') : $t('settings.externalData.save') }}
              </Button>
              <span v-if="externalDataSourceSaved === source.id" class="text-xs text-emerald-600 dark:text-emerald-500">
                {{ $t('settings.externalData.saved') }}
              </span>
            </div>
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
