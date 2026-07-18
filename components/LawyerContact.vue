<script setup lang="ts">
// "Anwalt kontaktieren" widget for the auction detail page
// (pages/objekt/[platform]/[id].vue). Loads the lawyer catalog for the
// auction's country, lets the user pick one + write a message, and POSTs to
// /api/lawyer-inquiries (guarded — requires login). Renders nothing when no
// lawyer covers the country; shows a login hint instead of the form when
// signed out.

import type { PublicLawyer } from '~/server/api/lawyers.get'

const props = defineProps<{
  platform: string
  externalId: string
  country: string
}>()

const { user } = useAuth()
const route = useRoute()

const lawyers = ref<PublicLawyer[]>([])
const loaded = ref(false)

async function loadLawyers(): Promise<void> {
  loaded.value = false
  try {
    lawyers.value = await $fetch<PublicLawyer[]>('/api/lawyers', { query: { country: props.country } })
  } catch {
    lawyers.value = []
  } finally {
    loaded.value = true
  }
}
watch(() => props.country, loadLawyers, { immediate: true })

const selectedLawyerId = ref('')
watch(lawyers, (list) => {
  if (!list.some((l) => l.id === selectedLawyerId.value)) {
    selectedLawyerId.value = list[0]?.id ?? ''
  }
})

const message = ref('')
const pending = ref(false)
const error = ref<string | null>(null)
const sent = ref(false)

async function submit(): Promise<void> {
  if (!selectedLawyerId.value || !message.value.trim()) return
  pending.value = true
  error.value = null
  try {
    await authFetch('/api/lawyer-inquiries', {
      method: 'POST',
      body: {
        lawyerId: selectedLawyerId.value,
        platform: props.platform,
        externalId: props.externalId,
        message: message.value.trim(),
      },
    })
    sent.value = true
    message.value = ''
  } catch (err) {
    error.value = (err as { statusMessage?: string; message?: string }).statusMessage
      || (err as Error).message
      || 'Anfrage konnte nicht gesendet werden.'
  } finally {
    pending.value = false
  }
}

function loginLink(): string {
  return `/login?redirect=${encodeURIComponent(route.fullPath)}`
}
</script>

<template>
  <section v-if="loaded && lawyers.length > 0" class="mb-8 space-y-3">
    <h2 class="text-base font-semibold">Anwalt kontaktieren</h2>

    <div v-if="!user" class="rounded-xl border bg-card p-5 text-sm space-y-2">
      <p class="text-muted-foreground">
        Melde dich an, um einen der spezialisierten Anwälte für dieses Land direkt über die Plattform anzuschreiben.
      </p>
      <NuxtLink :to="loginLink()" class="text-primary hover:underline">Jetzt anmelden</NuxtLink>
    </div>

    <form v-else class="rounded-xl border bg-card p-5 space-y-4" @submit.prevent="submit">
      <div class="space-y-1">
        <label class="text-sm font-medium" for="lawyer-select">Anwalt</label>
        <select
          id="lawyer-select"
          v-model="selectedLawyerId"
          class="w-full h-9 rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option v-for="l in lawyers" :key="l.id" :value="l.id">
            {{ l.name }}{{ l.firm ? ` (${l.firm})` : '' }}{{ l.specialization ? ` — ${l.specialization}` : '' }}
          </option>
        </select>
        <p v-if="selectedLawyerId" class="text-xs text-muted-foreground">
          <template v-for="l in lawyers.filter((x) => x.id === selectedLawyerId)" :key="l.id">
            <span v-if="l.languages?.length">Sprachen: {{ l.languages.join(', ') }}</span>
            <a v-if="l.website" :href="l.website" target="_blank" rel="noopener" class="ml-2 hover:underline">Website ↗</a>
          </template>
        </p>
      </div>

      <div class="space-y-1">
        <label class="text-sm font-medium" for="lawyer-message">Nachricht</label>
        <textarea
          id="lawyer-message"
          v-model="message"
          rows="4"
          placeholder="Beschreibe kurz dein Anliegen zu dieser Auktion …"
          class="w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          :disabled="pending"
        />
      </div>

      <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
      <p v-if="sent" class="text-sm text-emerald-600 dark:text-emerald-500">Anfrage gesendet.</p>

      <button
        type="submit"
        class="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        :disabled="pending || !selectedLawyerId || !message.trim()"
      >{{ pending ? 'Sende …' : 'Anfrage senden' }}</button>
    </form>
  </section>
</template>
