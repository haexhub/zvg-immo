<script setup lang="ts">
import { Pencil, Trash2 } from 'lucide-vue-next'
import { useSettingsAction } from '~/composables/settings/useSettingsAction'
import type { AdminLawyer } from '~/server/api/settings/lawyers/index.get'

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

const { t } = useI18n()
const { pending: lawyersPending, error: lawyersError, run } = useSettingsAction()

const lawyers = ref<AdminLawyer[]>([])
const editingId = ref<string | null>(null)
const showForm = ref(false)
const form = ref<LawyerFormState>(emptyForm())

function emptyForm(): LawyerFormState {
  return {
    name: '',
    firm: '',
    email: '',
    phone: '',
    countries: '',
    specialization: '',
    languages: '',
    website: '',
    commissionEur: '',
    active: true,
  }
}

async function loadLawyers(): Promise<void> {
  const res = await run(() => $fetch<AdminLawyer[]>('/api/settings/lawyers'), 'settings.lawyers.loadError')
  if (res) lawyers.value = res
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
  const result = editingId.value
    ? await run(() => $fetch<AdminLawyer>(`/api/settings/lawyers/${editingId.value}`, { method: 'PUT', body }), 'settings.lawyers.saveError')
    : await run(() => $fetch<AdminLawyer>('/api/settings/lawyers', { method: 'POST', body }), 'settings.lawyers.saveError')
  if (result === undefined) return
  await loadLawyers()
  cancelForm()
}

async function toggleActive(l: AdminLawyer): Promise<void> {
  const result = await run(() => $fetch<AdminLawyer>(`/api/settings/lawyers/${l.id}`, {
    method: 'PUT',
    body: {
      name: l.name,
      firm: l.firm,
      email: l.email,
      phone: l.phone,
      countries: l.countries,
      specialization: l.specialization,
      languages: l.languages,
      website: l.website,
      commissionCents: l.commissionCents,
      active: !l.active,
    },
  }), 'settings.lawyers.updateError')
  if (result !== undefined) await loadLawyers()
}

async function deleteLawyer(l: AdminLawyer): Promise<void> {
  // The server sets a specific 409 statusMessage when the lawyer still has
  // inquiries ([id].delete.ts) — normalizeSettingsError already surfaces
  // that verbatim, no bespoke status-code branch needed here.
  const result = await run(() => $fetch<{ ok: true }>(`/api/settings/lawyers/${l.id}`, { method: 'DELETE' }), 'settings.lawyers.deleteError')
  if (result !== undefined) await loadLawyers()
}

onMounted(loadLawyers)
</script>

<template>
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
                <Button type="button" variant="ghost" size="icon" :title="$t('settings.lawyers.delete')" class="hover:text-destructive" :disabled="lawyersPending" @click="deleteLawyer(l)">
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
</template>
