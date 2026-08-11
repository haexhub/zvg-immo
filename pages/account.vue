<script setup lang="ts">
import { getSupabaseClient } from '~/lib/supabase-client'
import type { SavedSearch } from '~/server/api/saved-searches/index.get'
import type { WatchlistItem } from '~/server/api/watchlist/index.get'
import type { LawyerInquiry } from '~/server/api/lawyer-inquiries/index.post'
import type { ApiKeySummary } from '~/server/api/api-keys/index.get'
import type { CreatedApiKey } from '~/server/api/api-keys/index.post'
import { Trash2 } from 'lucide-vue-next'

useSeoMeta({ robots: 'noindex, nofollow' })

const router = useRouter()
const { user } = useAuth()
const { t, te } = useI18n()
const intlLocale = useIntlLocale()

// Auth state resolves asynchronously on the client (see composables/useAuth.ts) —
// do a definitive one-time session check on mount before deciding whether to
// redirect, rather than reacting to the still-null initial value of `user`.
const checked = ref(false)
onMounted(async () => {
  const client = getSupabaseClient()
  const { data } = client ? await client.auth.getSession() : { data: { session: null } }
  if (!data.session) {
    router.replace('/login?redirect=/account')
    return
  }
  checked.value = true
  await Promise.all([loadSavedSearches(), loadWatchlist(), loadLawyerInquiries(), loadApiKeys()])
})

// Redirect if the user logs out while already on this page.
watch(user, (u) => {
  if (checked.value && !u) router.replace('/login?redirect=/account')
})

const savedSearches = ref<SavedSearch[]>([])
const watchlist = ref<WatchlistItem[]>([])
const lawyerInquiries = ref<LawyerInquiry[]>([])

async function loadSavedSearches(): Promise<void> {
  savedSearches.value = await authFetch<SavedSearch[]>('/api/saved-searches')
}
async function loadWatchlist(): Promise<void> {
  watchlist.value = await authFetch<WatchlistItem[]>('/api/watchlist')
}
async function loadLawyerInquiries(): Promise<void> {
  lawyerInquiries.value = await authFetch<LawyerInquiry[]>('/api/lawyer-inquiries')
}

function commissionStatusLabel(status: string): string {
  const key = `account.lawyerInquiries.status.${status}`
  return te(key) ? t(key) : status
}

async function deleteSavedSearch(id: string): Promise<void> {
  await authFetch(`/api/saved-searches/${id}`, { method: 'DELETE' })
  savedSearches.value = savedSearches.value.filter((s) => s.id !== id)
}
async function removeWatchlistItem(id: string): Promise<void> {
  await authFetch(`/api/watchlist/${id}`, { method: 'DELETE' })
  watchlist.value = watchlist.value.filter((w) => w.id !== id)
}

// API-Keys (Phase 5, Daten-API unter /api/data/v1/*). The plaintext key is
// only ever present in the POST response — justCreatedKey holds it purely
// client-side for this one page render, never persisted, never re-fetchable.
const apiKeys = ref<ApiKeySummary[]>([])
const newKeyLabel = ref('')
const justCreatedKey = ref<CreatedApiKey | null>(null)
const keyCopied = ref(false)

async function loadApiKeys(): Promise<void> {
  apiKeys.value = await authFetch<ApiKeySummary[]>('/api/api-keys')
}

async function createApiKey(): Promise<void> {
  const label = newKeyLabel.value.trim()
  if (!label) return
  const created = await authFetch<CreatedApiKey>('/api/api-keys', {
    method: 'POST',
    body: { label },
  })
  justCreatedKey.value = created
  keyCopied.value = false
  newKeyLabel.value = ''
  await loadApiKeys()
}

async function revokeApiKey(id: string): Promise<void> {
  if (!confirm(t('account.apiKeys.revokeConfirm')))
    return
  await authFetch(`/api/api-keys/${id}`, { method: 'DELETE' })
  apiKeys.value = apiKeys.value.map((k) => (k.id === id ? { ...k, active: false } : k))
}

async function copyKey(): Promise<void> {
  if (!justCreatedKey.value) return
  await navigator.clipboard.writeText(justCreatedKey.value.plaintext)
  keyCopied.value = true
}

// Human-readable summary of a saved search's filters (the route.query shape —
// see lib/auction-filters.ts for what the field names mean).
function fieldLabel(key: string): string {
  const i18nKey = `filters.field.${key}`
  return te(i18nKey) ? t(i18nKey) : key
}
function summarize(filters: Record<string, string>): string {
  const parts = Object.entries(filters)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${fieldLabel(k)}: ${v}`)
  return parts.length ? parts.join(' · ') : t('account.savedSearches.allAuctions')
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(intlLocale.value)
}
</script>

<template>
  <main class="px-4 py-6">
    <div class="max-w-3xl mx-auto space-y-8">
      <h1 class="text-2xl font-bold tracking-tight">{{ $t('account.title') }}</h1>

      <template v-if="checked">
        <section class="space-y-3">
          <h2 class="text-base font-semibold">{{ $t('account.savedSearches.title') }}</h2>
          <p v-if="savedSearches.length === 0" class="text-sm text-muted-foreground">
            {{ $t('account.savedSearches.empty') }}
          </p>
          <ul v-else class="space-y-2">
            <li
              v-for="s in savedSearches"
              :key="s.id"
              class="flex items-center justify-between gap-3 rounded-md border bg-card px-4 py-3"
            >
              <div class="min-w-0">
                <NuxtLink :to="{ path: '/search', query: s.filters }" class="font-medium hover:underline">
                  {{ s.name }}
                </NuxtLink>
                <p class="text-xs text-muted-foreground truncate">{{ summarize(s.filters) }}</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                class="shrink-0 hover:text-destructive"
                :title="$t('account.savedSearches.delete')"
                @click="deleteSavedSearch(s.id)"
              >
                <Trash2 class="h-4 w-4" />
              </Button>
            </li>
          </ul>
        </section>

        <section class="space-y-3">
          <h2 class="text-base font-semibold">{{ $t('account.watchlist.title') }}</h2>
          <p v-if="watchlist.length === 0" class="text-sm text-muted-foreground">
            {{ $t('account.watchlist.empty') }}
          </p>
          <ul v-else class="space-y-2">
            <li
              v-for="w in watchlist"
              :key="w.id"
              class="flex items-center justify-between gap-3 rounded-md border bg-card px-4 py-3"
            >
              <div class="min-w-0">
                <NuxtLink
                  :to="`/objekt/${encodeURIComponent(w.platform)}/${encodeURIComponent(w.externalId)}`"
                  class="font-medium hover:underline"
                >
                  {{ w.authority || w.platform }} · {{ w.caseNumber || w.externalId }}
                </NuxtLink>
                <p class="text-xs text-muted-foreground">{{ $t('account.watchlist.added', { date: formatDate(w.createdAt) }) }}</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                class="shrink-0 hover:text-destructive"
                :title="$t('account.watchlist.remove')"
                @click="removeWatchlistItem(w.id)"
              >
                <Trash2 class="h-4 w-4" />
              </Button>
            </li>
          </ul>
        </section>

        <section class="space-y-3">
          <h2 class="text-base font-semibold">{{ $t('account.lawyerInquiries.title') }}</h2>
          <p v-if="lawyerInquiries.length === 0" class="text-sm text-muted-foreground">
            {{ $t('account.lawyerInquiries.empty') }}
          </p>
          <ul v-else class="space-y-2">
            <li
              v-for="i in lawyerInquiries"
              :key="i.id"
              class="rounded-md border bg-card px-4 py-3 space-y-1"
            >
              <div class="flex items-center justify-between gap-3">
                <NuxtLink
                  v-if="i.platform && i.externalId"
                  :to="`/objekt/${encodeURIComponent(i.platform)}/${encodeURIComponent(i.externalId)}`"
                  class="font-medium hover:underline"
                >{{ $t('account.lawyerInquiries.viewAuction') }}</NuxtLink>
                <span class="text-xs text-muted-foreground">{{ formatDate(i.createdAt) }}</span>
              </div>
              <p class="text-sm text-muted-foreground truncate">{{ i.message }}</p>
              <p class="text-xs text-muted-foreground">
                {{ $t('account.lawyerInquiries.commissionStatus', { status: commissionStatusLabel(i.commissionStatus) }) }}
              </p>
            </li>
          </ul>
        </section>

        <section class="space-y-3">
          <h2 class="text-base font-semibold">{{ $t('account.apiKeys.title') }}</h2>
          <div class="space-y-1 text-sm text-muted-foreground">
            <i18n-t keypath="account.apiKeys.intro" tag="p">
              <template #path><code>/api/data/v1/*</code></template>
              <template #header><code>Authorization: Bearer &lt;key&gt;</code></template>
            </i18n-t>
            <ul class="list-disc space-y-0.5 pl-5">
              <li><code>GET /api/data/v1/auctions</code> — {{ $t('account.apiKeys.listAuctions') }}</li>
              <li><code>GET /api/data/v1/auctions/:platform/:id</code> — {{ $t('account.apiKeys.getAuction') }}</li>
              <li><code>GET /api/data/v1/observations</code> — {{ $t('account.apiKeys.observations') }}</li>
            </ul>
            <p>
              {{ $t('account.apiKeys.example') }} <code>curl -H "Authorization: Bearer &lt;key&gt;" https://…/api/data/v1/auctions</code>
            </p>
          </div>

          <form class="flex gap-2" @submit.prevent="createApiKey">
            <Input
              v-model="newKeyLabel"
              type="text"
              :placeholder="$t('account.apiKeys.labelPlaceholder')"
              class="flex-1"
            />
            <Button type="submit" class="shrink-0">
              {{ $t('account.apiKeys.create') }}
            </Button>
          </form>

          <div
            v-if="justCreatedKey"
            class="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3"
          >
            <p class="text-sm font-medium">
              {{ $t('account.apiKeys.newKeyNotice', { label: justCreatedKey.label }) }}
            </p>
            <div class="flex items-center gap-2">
              <code class="flex-1 truncate rounded bg-background px-2 py-1 text-xs">{{ justCreatedKey.plaintext }}</code>
              <Button type="button" variant="outline" size="sm" class="shrink-0" @click="copyKey">
                {{ keyCopied ? $t('account.apiKeys.copied') : $t('account.apiKeys.copy') }}
              </Button>
            </div>
            <p class="text-xs text-muted-foreground">
              {{ $t('account.apiKeys.saveNowNotice') }}
            </p>
          </div>

          <p v-if="apiKeys.length === 0" class="text-sm text-muted-foreground">
            {{ $t('account.apiKeys.empty') }}
          </p>
          <ul v-else class="space-y-2">
            <li
              v-for="k in apiKeys"
              :key="k.id"
              class="flex items-center justify-between gap-3 rounded-md border bg-card px-4 py-3"
            >
              <div class="min-w-0">
                <p class="font-medium">
                  {{ k.label }}
                  <span v-if="!k.active" class="text-xs font-normal text-muted-foreground">{{ $t('account.apiKeys.revoked') }}</span>
                </p>
                <p class="text-xs text-muted-foreground">
                  {{ k.keyPrefix }}… · {{ $t('account.apiKeys.created', { date: formatDate(k.createdAt) }) }}
                  · {{ $t('account.apiKeys.lastUsed', { date: k.lastUsedAt ? formatDate(k.lastUsedAt) : $t('account.apiKeys.neverUsed') }) }}
                </p>
              </div>
              <Button
                v-if="k.active"
                type="button"
                variant="ghost"
                size="icon"
                class="shrink-0 hover:text-destructive"
                :title="$t('account.apiKeys.revoke')"
                @click="revokeApiKey(k.id)"
              >
                <Trash2 class="h-4 w-4" />
              </Button>
            </li>
          </ul>
        </section>
      </template>
      <p v-else class="py-12 text-center text-muted-foreground">{{ $t('account.loading') }}</p>
    </div>
  </main>
</template>
