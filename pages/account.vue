<script setup lang="ts">
import { getSupabaseClient } from '~/lib/supabase-client'
import type { SavedSearch } from '~/server/api/saved-searches/index.get'
import type { WatchlistItem } from '~/server/api/watchlist/index.get'
import type { LawyerInquiry } from '~/server/api/lawyer-inquiries/index.post'
import type { ApiKeySummary } from '~/server/api/api-keys/index.get'
import type { CreatedApiKey } from '~/server/api/api-keys/index.post'
import { Trash2 } from 'lucide-vue-next'

const router = useRouter()
const { user } = useAuth()

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

const COMMISSION_STATUS_LABEL: Record<string, string> = {
  pending: 'Ausstehend',
  invoiced: 'In Rechnung gestellt',
  paid: 'Bezahlt',
  waived: 'Erlassen',
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
  if (!confirm('Möchten Sie diesen API-Key wirklich widerrufen? Er kann danach nicht mehr verwendet werden.'))
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
const FIELD_LABEL: Record<string, string> = {
  country: 'Land',
  region: 'Region',
  q: 'Suche',
  authority: 'Gericht',
  priceMin: 'Preis ab',
  priceMax: 'Preis bis',
  landMin: 'Grundstück ab',
  landMax: 'Grundstück bis',
  livMin: 'Wohnfläche ab',
  livMax: 'Wohnfläche bis',
  category: 'Objektart',
  photos: 'Nur mit Fotos',
  cancelled: 'inkl. aufgehobene',
}
function summarize(filters: Record<string, string>): string {
  const parts = Object.entries(filters)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${FIELD_LABEL[k] ?? k}: ${v}`)
  return parts.length ? parts.join(' · ') : 'Alle Auktionen'
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('de-DE')
}
</script>

<template>
  <main class="h-screen overflow-y-auto px-4 py-6">
    <div class="max-w-3xl mx-auto space-y-8">
      <div class="flex items-center justify-between">
        <h1 class="text-2xl font-bold tracking-tight">Mein Konto</h1>
        <AuthStatus />
      </div>

      <template v-if="checked">
        <section class="space-y-3">
          <h2 class="text-base font-semibold">Gespeicherte Suchen</h2>
          <p v-if="savedSearches.length === 0" class="text-sm text-muted-foreground">
            Noch keine gespeicherten Suchen.
          </p>
          <ul v-else class="space-y-2">
            <li
              v-for="s in savedSearches"
              :key="s.id"
              class="flex items-center justify-between gap-3 rounded-md border bg-card px-4 py-3"
            >
              <div class="min-w-0">
                <NuxtLink :to="{ path: '/', query: s.filters }" class="font-medium hover:underline">
                  {{ s.name }}
                </NuxtLink>
                <p class="text-xs text-muted-foreground truncate">{{ summarize(s.filters) }}</p>
              </div>
              <button
                type="button"
                class="shrink-0 text-muted-foreground hover:text-destructive"
                title="Löschen"
                @click="deleteSavedSearch(s.id)"
              >
                <Trash2 class="h-4 w-4" />
              </button>
            </li>
          </ul>
        </section>

        <section class="space-y-3">
          <h2 class="text-base font-semibold">Watchlist</h2>
          <p v-if="watchlist.length === 0" class="text-sm text-muted-foreground">
            Noch keine Favoriten.
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
                <p class="text-xs text-muted-foreground">Hinzugefügt {{ formatDate(w.createdAt) }}</p>
              </div>
              <button
                type="button"
                class="shrink-0 text-muted-foreground hover:text-destructive"
                title="Entfernen"
                @click="removeWatchlistItem(w.id)"
              >
                <Trash2 class="h-4 w-4" />
              </button>
            </li>
          </ul>
        </section>

        <section class="space-y-3">
          <h2 class="text-base font-semibold">Meine Anwalts-Anfragen</h2>
          <p v-if="lawyerInquiries.length === 0" class="text-sm text-muted-foreground">
            Noch keine Anfragen gesendet.
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
                >Auktion ansehen</NuxtLink>
                <span class="text-xs text-muted-foreground">{{ formatDate(i.createdAt) }}</span>
              </div>
              <p class="text-sm text-muted-foreground truncate">{{ i.message }}</p>
              <p class="text-xs text-muted-foreground">
                Provisionsstatus: {{ COMMISSION_STATUS_LABEL[i.commissionStatus] ?? i.commissionStatus }}
              </p>
            </li>
          </ul>
        </section>

        <section class="space-y-3">
          <h2 class="text-base font-semibold">API-Keys</h2>
          <div class="space-y-1 text-sm text-muted-foreground">
            <p>
              Programmatischer Lesezugriff (Snapshot + Historie) unter <code>/api/data/v1/*</code>,
              authentifiziert per <code>Authorization: Bearer &lt;key&gt;</code>:
            </p>
            <ul class="list-disc space-y-0.5 pl-5">
              <li><code>GET /api/data/v1/auctions</code> — aktueller Bestand, filter- und paginierbar</li>
              <li><code>GET /api/data/v1/auctions/:platform/:id</code> — einzelne Auktion</li>
              <li><code>GET /api/data/v1/observations</code> — Zeitreihe je Auktion (Quoten-/Preistrends)</li>
            </ul>
            <p>
              Beispiel: <code>curl -H "Authorization: Bearer &lt;key&gt;" https://…/api/data/v1/auctions</code>
            </p>
          </div>

          <form class="flex gap-2" @submit.prevent="createApiKey">
            <input
              v-model="newKeyLabel"
              type="text"
              placeholder="Label, z. B. „Analyse-Skript“"
              class="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
            />
            <button
              type="submit"
              class="shrink-0 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
            >
              Key erzeugen
            </button>
          </form>

          <div
            v-if="justCreatedKey"
            class="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3"
          >
            <p class="text-sm font-medium">
              Neuer Key „{{ justCreatedKey.label }}“ — wird nur jetzt angezeigt, danach nicht mehr abrufbar:
            </p>
            <div class="flex items-center gap-2">
              <code class="flex-1 truncate rounded bg-background px-2 py-1 text-xs">{{ justCreatedKey.plaintext }}</code>
              <button
                type="button"
                class="shrink-0 rounded-md border px-2 py-1 text-xs"
                @click="copyKey"
              >
                {{ keyCopied ? 'Kopiert!' : 'Kopieren' }}
              </button>
            </div>
            <p class="text-xs text-muted-foreground">
              Jetzt sichern — dieser Key wird aus Sicherheitsgründen nie wieder angezeigt.
            </p>
          </div>

          <p v-if="apiKeys.length === 0" class="text-sm text-muted-foreground">
            Noch keine API-Keys.
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
                  <span v-if="!k.active" class="text-xs font-normal text-muted-foreground">(widerrufen)</span>
                </p>
                <p class="text-xs text-muted-foreground">
                  {{ k.keyPrefix }}… · erzeugt {{ formatDate(k.createdAt) }}
                  · zuletzt genutzt {{ k.lastUsedAt ? formatDate(k.lastUsedAt) : 'nie' }}
                </p>
              </div>
              <button
                v-if="k.active"
                type="button"
                class="shrink-0 text-muted-foreground hover:text-destructive"
                title="Widerrufen"
                @click="revokeApiKey(k.id)"
              >
                <Trash2 class="h-4 w-4" />
              </button>
            </li>
          </ul>
        </section>
      </template>
      <p v-else class="py-12 text-center text-muted-foreground">Lade …</p>
    </div>
  </main>
</template>
