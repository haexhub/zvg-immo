<script setup lang="ts">
// Admin-only technical overview for one auction (docs/plans/2026-08-08-
// admin-auktions-technikseite.md, WP-3). Same auth pattern as pages/settings.vue
// — this route deliberately lives outside pages/settings/ (see the plan's
// routing decision) but calls the same /api/settings/* endpoints, which is
// what server/middleware/settings-auth.ts actually guards.
import { ArrowLeft } from 'lucide-vue-next'
import { useSettingsError } from '~/composables/settings/useSettingsError'
import type { AuctionTechnicalOverview } from '~/server/utils/auction-technical'

const route = useRoute()
const platform = String(route.params.platform)
const id = String(route.params.id)
const { t, locale } = useI18n()

useHead({ title: t('settings.auctionTechnical.title', { platform, id }) })

const authed = ref(false)
const passwordInput = ref('')
const authError = ref<string | null>(null)
const authPending = ref(false)

const overview = ref<AuctionTechnicalOverview | null>(null)
const overviewPending = ref(false)
const overviewError = ref<string | null>(null)

function clearAuthState(): void {
  authed.value = false
}

const { normalizeSettingsError } = useSettingsError()

async function probeSession(): Promise<void> {
  try {
    const res = await $fetch<{ authed: boolean }>('/api/settings/session', { cache: 'no-store' })
    authed.value = res.authed
    if (authed.value) await loadOverview()
  } catch {
    authed.value = false
  }
}

async function login(): Promise<void> {
  authError.value = null
  authPending.value = true
  try {
    await $fetch('/api/settings/login', { method: 'POST', body: { password: passwordInput.value } })
    passwordInput.value = ''
    authed.value = true
    await loadOverview()
  } catch (err) {
    const e = typeof err === 'object' && err !== null
      ? err as { data?: { statusMessage?: string }; statusMessage?: string; message?: string }
      : {}
    authError.value = e.data?.statusMessage || e.statusMessage || e.message || t('settings.login.error')
  } finally {
    authPending.value = false
  }
}

async function loadOverview(): Promise<void> {
  overviewPending.value = true
  overviewError.value = null
  try {
    overview.value = await $fetch<AuctionTechnicalOverview>(
      `/api/settings/auction/${encodeURIComponent(platform)}/${encodeURIComponent(id)}/technical`,
    )
  } catch (err) {
    overview.value = null
    overviewError.value = normalizeSettingsError(err, t('settings.auctionTechnical.loadError'))
    if ((err as { statusCode?: number }).statusCode === 401) clearAuthState()
  } finally {
    overviewPending.value = false
  }
}

function formatDate(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString(locale.value)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`
}

onMounted(probeSession)
</script>

<template>
  <main class="px-4 py-6">
    <div class="mx-auto max-w-6xl space-y-6">
      <div class="flex items-center justify-between gap-3">
        <NuxtLink :to="`/objekt/${platform}/${id}`" class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft class="h-4 w-4" /> {{ $t('settings.auctionTechnical.back') }}
        </NuxtLink>
      </div>
      <h1 class="text-2xl font-bold tracking-tight">
        {{ $t('settings.auctionTechnical.heading', { platform, id }) }}
      </h1>

      <Card v-if="!authed" class="mx-auto max-w-2xl">
        <CardHeader>
          <CardTitle>{{ $t('settings.login.title') }}</CardTitle>
        </CardHeader>
        <CardContent class="space-y-4">
          <p class="text-sm text-muted-foreground">{{ $t('settings.login.protected') }}</p>
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
        <p v-if="overviewPending" class="text-sm text-muted-foreground">{{ $t('settings.auctionTechnical.loading') }}</p>
        <p v-if="overviewError" class="text-sm text-destructive">{{ overviewError }}</p>

        <template v-if="overview">
          <Card>
            <CardHeader><CardTitle>{{ $t('settings.auctionTechnical.sections.identity') }}</CardTitle></CardHeader>
            <CardContent class="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.country') }}</div><div>{{ overview.identity.country }} / {{ overview.identity.region }}</div></div>
              <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.authority') }}</div><div>{{ overview.identity.authority }}</div></div>
              <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.caseNumber') }}</div><div>{{ overview.identity.caseNumber }}</div></div>
              <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.coordinates') }}</div><div>{{ overview.identity.lat ?? '—' }}, {{ overview.identity.lng ?? '—' }}</div></div>
              <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.geocodeResult') }}</div><div>{{ overview.identity.geocodeResult ?? '—' }} ({{ overview.identity.geocodeProvider ?? '—' }})</div></div>
              <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.geocodeAttemptedAt') }}</div><div>{{ formatDate(overview.identity.geocodeAttemptedAt) }}</div></div>
              <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.firstSeenAt') }}</div><div>{{ formatDate(overview.identity.firstSeenAt) }}</div></div>
              <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.updatedAt') }}</div><div>{{ formatDate(overview.identity.updatedAt) }}</div></div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{{ $t('settings.auctionTechnical.sections.fetchState') }}</CardTitle></CardHeader>
            <CardContent v-if="overview.fetchState" class="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.detailFetchedAt') }}</div><div>{{ formatDate(overview.fetchState.detailFetchedAt) }}</div></div>
              <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.llmFailures') }}</div><div>{{ overview.fetchState.llmFailures }}</div></div>
              <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.llmLastAttemptedAt') }}</div><div>{{ formatDate(overview.fetchState.llmLastAttemptedAt) }}</div></div>
              <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.llmBatchJob') }}</div><div>{{ overview.fetchState.llmBatchJob ?? '—' }}</div></div>
              <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.photoFailures') }}</div><div>{{ overview.fetchState.photoFailures }}</div></div>
              <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.photosCheckedAt') }}</div><div>{{ formatDate(overview.fetchState.photosCheckedAt) }}</div></div>
              <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.attachments') }}</div><div>{{ overview.fetchState.attachments.length }}</div></div>
            </CardContent>
            <CardContent v-else class="text-sm text-muted-foreground">{{ $t('settings.auctionTechnical.noData') }}</CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{{ $t('settings.auctionTechnical.sections.extractionHistory') }}</CardTitle></CardHeader>
            <CardContent>
              <Table v-if="overview.extractionHistory.length">
                <TableHeader>
                  <TableRow>
                    <TableHead>{{ $t('settings.auctionTechnical.fields.version') }}</TableHead>
                    <TableHead>{{ $t('settings.auctionTechnical.fields.status') }}</TableHead>
                    <TableHead>{{ $t('settings.auctionTechnical.fields.provider') }}</TableHead>
                    <TableHead>{{ $t('settings.auctionTechnical.fields.runTrigger') }}</TableHead>
                    <TableHead>{{ $t('settings.auctionTechnical.fields.duration') }}</TableHead>
                    <TableHead>{{ $t('settings.auctionTechnical.fields.confidence') }}</TableHead>
                    <TableHead>{{ $t('settings.auctionTechnical.fields.createdAt') }}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="row in overview.extractionHistory" :key="row.version">
                    <TableCell>{{ row.version }}</TableCell>
                    <TableCell class="space-x-1">
                      <Badge v-if="row.isLatest" variant="default">{{ $t('settings.auctionTechnical.badges.live') }}</Badge>
                      <Badge v-if="row.isTrial" variant="secondary">{{ $t('settings.auctionTechnical.badges.trial') }}</Badge>
                    </TableCell>
                    <TableCell>{{ row.llmProvider ? `${row.llmProvider}/${row.llmModel}` : (row.extractionSource ?? '—') }}</TableCell>
                    <TableCell>{{ row.runTrigger ?? '—' }}</TableCell>
                    <TableCell>{{ row.llmDurationMs != null ? `${row.llmDurationMs} ms` : '—' }}</TableCell>
                    <TableCell>{{ row.extractionConfidence ?? '—' }}</TableCell>
                    <TableCell>{{ formatDate(row.createdAt) }}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
              <p v-else class="text-sm text-muted-foreground">{{ $t('settings.auctionTechnical.noData') }}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{{ $t('settings.auctionTechnical.sections.errors') }}</CardTitle></CardHeader>
            <CardContent class="space-y-2">
              <p v-if="!overview.errors.length" class="text-sm text-muted-foreground">{{ $t('settings.auctionTechnical.noData') }}</p>
              <div v-for="err in overview.errors" :key="err.id" class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
                <div class="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{{ err.task }}</span> · <span>{{ err.category }}</span> · <span>{{ formatDate(err.createdAt) }}</span>
                </div>
                <div class="text-destructive">{{ err.message }}</div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{{ $t('settings.auctionTechnical.sections.translations') }}</CardTitle></CardHeader>
            <CardContent>
              <Table v-if="overview.translations.length">
                <TableHeader>
                  <TableRow>
                    <TableHead>{{ $t('settings.auctionTechnical.fields.lang') }}</TableHead>
                    <TableHead>{{ $t('settings.auctionTechnical.fields.version') }}</TableHead>
                    <TableHead>{{ $t('settings.auctionTechnical.fields.status') }}</TableHead>
                    <TableHead>{{ $t('settings.auctionTechnical.fields.error') }}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="row in overview.translations" :key="`${row.version}-${row.lang}`">
                    <TableCell>{{ row.lang }}</TableCell>
                    <TableCell>{{ row.version }}</TableCell>
                    <TableCell>
                      <Badge :variant="row.status === 'failed' ? 'destructive' : row.status === 'completed' ? 'default' : 'secondary'">
                        {{ row.status }}
                      </Badge>
                    </TableCell>
                    <TableCell class="text-destructive">{{ row.errorMessage ?? '—' }}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
              <p v-else class="text-sm text-muted-foreground">{{ $t('settings.auctionTechnical.noData') }}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{{ $t('settings.auctionTechnical.sections.externalData') }}</CardTitle></CardHeader>
            <CardContent class="space-y-4 text-sm">
              <div v-if="overview.externalData.coverage" class="flex flex-wrap gap-2">
                <Badge
                  v-for="source in overview.externalData.coverage.sources"
                  :key="source.id"
                  :variant="source.covered ? 'default' : 'outline'"
                >
                  {{ source.id }}
                </Badge>
              </div>
              <p v-else class="text-muted-foreground">{{ $t('settings.auctionTechnical.noData') }}</p>
              <div v-if="overview.externalData.geoMetrics" class="grid grid-cols-2 gap-3 md:grid-cols-4">
                <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.distSea') }}</div><div>{{ overview.externalData.geoMetrics.distSeaM ?? '—' }}</div></div>
                <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.distMountain') }}</div><div>{{ overview.externalData.geoMetrics.distMountainM ?? '—' }}</div></div>
                <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.distAirport') }}</div><div>{{ overview.externalData.geoMetrics.distAirportM ?? '—' }}</div></div>
                <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.computedAt') }}</div><div>{{ formatDate(overview.externalData.geoMetrics.computedAt) }}</div></div>
              </div>
              <div v-if="overview.externalData.climateCell" class="grid grid-cols-2 gap-3 md:grid-cols-4">
                <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.climateSummer') }}</div><div>{{ overview.externalData.climateCell.summerAvgTempC ?? '—' }} °C</div></div>
                <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.climateWinter') }}</div><div>{{ overview.externalData.climateCell.winterAvgTempC ?? '—' }} °C</div></div>
                <div><div class="text-xs text-muted-foreground">{{ $t('settings.auctionTechnical.fields.climateSourceVersion') }}</div><div>{{ overview.externalData.climateCell.sourceVersion ?? '—' }}</div></div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{{ $t('settings.auctionTechnical.sections.llmBatchJobs') }}</CardTitle></CardHeader>
            <CardContent>
              <Table v-if="overview.llmBatchJobs.length">
                <TableHeader>
                  <TableRow>
                    <TableHead>{{ $t('settings.auctionTechnical.fields.jobName') }}</TableHead>
                    <TableHead>{{ $t('settings.auctionTechnical.fields.status') }}</TableHead>
                    <TableHead>{{ $t('settings.auctionTechnical.fields.submittedAt') }}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="job in overview.llmBatchJobs" :key="job.jobName">
                    <TableCell>{{ job.jobName }}</TableCell>
                    <TableCell>{{ job.status }}</TableCell>
                    <TableCell>{{ formatDate(job.submittedAt) }}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
              <p v-else class="text-sm text-muted-foreground">{{ $t('settings.auctionTechnical.noData') }}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{{ $t('settings.auctionTechnical.sections.documents') }}</CardTitle></CardHeader>
            <CardContent>
              <Table v-if="overview.documents.length">
                <TableHeader>
                  <TableRow>
                    <TableHead>{{ $t('settings.auctionTechnical.fields.kind') }}</TableHead>
                    <TableHead>{{ $t('settings.auctionTechnical.fields.filename') }}</TableHead>
                    <TableHead>{{ $t('settings.auctionTechnical.fields.setVersion') }}</TableHead>
                    <TableHead>{{ $t('settings.auctionTechnical.fields.byteSize') }}</TableHead>
                    <TableHead>{{ $t('settings.auctionTechnical.fields.capturedAt') }}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="doc in overview.documents" :key="doc.id">
                    <TableCell>{{ doc.kind }}</TableCell>
                    <TableCell>{{ doc.filename ?? doc.label ?? '—' }}</TableCell>
                    <TableCell>{{ doc.setVersion ?? '—' }}</TableCell>
                    <TableCell>{{ formatBytes(doc.byteSize) }}</TableCell>
                    <TableCell>{{ formatDate(doc.capturedAt) }}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
              <p v-else class="text-sm text-muted-foreground">{{ $t('settings.auctionTechnical.noData') }}</p>
            </CardContent>
          </Card>
        </template>
      </template>
    </div>
  </main>
</template>
