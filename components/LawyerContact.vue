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
const { t } = useI18n()

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
const idempotencyKey = ref<string | null>(null)

async function submit(): Promise<void> {
  if (!selectedLawyerId.value || !message.value.trim()) return
  pending.value = true
  error.value = null
  idempotencyKey.value ??= crypto.randomUUID()
  try {
    await authFetch('/api/lawyer-inquiries', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey.value },
      body: {
        lawyerId: selectedLawyerId.value,
        platform: props.platform,
        externalId: props.externalId,
        message: message.value.trim(),
      },
    })
    sent.value = true
    message.value = ''
    idempotencyKey.value = null
  } catch (err) {
    error.value = (err as { statusMessage?: string; message?: string }).statusMessage
      || (err as Error).message
      || t('lawyerContact.sendError')
  } finally {
    pending.value = false
  }
}

function loginLink(): string {
  return `/login?redirect=${encodeURIComponent(route.fullPath)}`
}
</script>

<template>
  <DetailSectionCard v-if="loaded && lawyers.length > 0" :title="t('lawyerContact.title')">
    <div v-if="!user" class="text-sm space-y-2">
      <p class="text-muted-foreground">
        {{ t('lawyerContact.loginHint') }}
      </p>
      <NuxtLink :to="loginLink()" class="text-primary hover:underline">{{ t('lawyerContact.loginNow') }}</NuxtLink>
    </div>

    <form v-else class="space-y-4" @submit.prevent="submit">
      <div class="space-y-1">
        <Label for="lawyer-select">{{ t('lawyerContact.lawyer') }}</Label>
        <Select v-model="selectedLawyerId">
          <SelectTrigger id="lawyer-select" class="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="l in lawyers" :key="l.id" :value="l.id">
              {{ l.name }}{{ l.firm ? ` (${l.firm})` : '' }}{{ l.specialization ? ` — ${l.specialization}` : '' }}
            </SelectItem>
          </SelectContent>
        </Select>
        <p v-if="selectedLawyerId" class="text-xs text-muted-foreground">
          <template v-for="l in lawyers.filter((x) => x.id === selectedLawyerId)" :key="l.id">
            <span v-if="l.languages?.length">{{ t('lawyerContact.languages', { languages: l.languages.join(', ') }) }}</span>
            <a v-if="l.website" :href="l.website" target="_blank" rel="noopener" class="ml-2 hover:underline">{{ t('lawyerContact.website') }}</a>
          </template>
        </p>
      </div>

      <div class="space-y-1">
        <Label for="lawyer-message">{{ t('lawyerContact.message') }}</Label>
        <Textarea
          id="lawyer-message"
          v-model="message"
          rows="4"
          :placeholder="t('lawyerContact.messagePlaceholder')"
          :disabled="pending"
        />
      </div>

      <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
      <p v-if="sent" class="text-sm text-emerald-600 dark:text-emerald-500">{{ t('lawyerContact.sent') }}</p>

      <Button type="submit" :disabled="pending || !selectedLawyerId || !message.trim()">
        {{ pending ? t('lawyerContact.sending') : t('lawyerContact.send') }}
      </Button>
    </form>
  </DetailSectionCard>
</template>
