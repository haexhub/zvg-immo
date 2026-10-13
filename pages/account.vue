<script setup lang="ts">
import { apiErrorMessage } from '~/lib/api-error'
import { getSupabaseClient } from '~/lib/supabase-client'
import type { WatchlistItem } from '~/server/api/watchlist/index.get'
import { Trash2 } from 'lucide-vue-next'

useSeoMeta({ robots: 'noindex, nofollow' })

const router = useRouter()
const { user } = useAuth()
const intlLocale = useIntlLocale()
const { t } = useI18n()

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
  await loadWatchlist()
})

// Redirect if the user logs out while already on this page.
watch(user, (u) => {
  if (checked.value && !u) router.replace('/login?redirect=/account')
})

const watchlist = ref<WatchlistItem[]>([])
// A failed load must not read as an empty watchlist.
const watchlistError = ref<string | null>(null)

async function loadWatchlist(): Promise<void> {
  try {
    watchlist.value = await authFetch<WatchlistItem[]>('/api/watchlist')
    watchlistError.value = null
  } catch (err) {
    watchlistError.value = apiErrorMessage(err, t('account.watchlist.loadError'))
  }
}

async function removeWatchlistItem(id: string): Promise<void> {
  try {
    await authFetch(`/api/watchlist/${encodeURIComponent(id)}`, { method: 'DELETE' })
    watchlist.value = watchlist.value.filter((w) => w.id !== id)
    watchlistError.value = null
  } catch (err) {
    watchlistError.value = apiErrorMessage(err, t('account.watchlist.updateError'))
  }
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
          <h2 class="text-base font-semibold">{{ $t('account.watchlist.title') }}</h2>
          <p v-if="watchlistError" class="text-sm text-destructive" role="alert">{{ watchlistError }}</p>
          <p v-if="watchlist.length === 0 && !watchlistError" class="text-sm text-muted-foreground">
            {{ $t('account.watchlist.empty') }}
          </p>
          <ul v-else-if="watchlist.length > 0" class="space-y-2">
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
      </template>
      <p v-else class="py-12 text-center text-muted-foreground">{{ $t('account.loading') }}</p>
    </div>
  </main>
</template>
