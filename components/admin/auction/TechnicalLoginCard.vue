<script setup lang="ts">
defineProps<{
  pending: boolean
  error: string | null
}>()

const password = defineModel<string>('password', { required: true })
const emit = defineEmits<{ submit: [] }>()
</script>

<template>
  <Card class="mx-auto max-w-2xl">
    <CardHeader>
      <CardTitle>{{ $t('settings.login.title') }}</CardTitle>
    </CardHeader>
    <CardContent class="space-y-4">
      <p class="text-sm text-muted-foreground">{{ $t('settings.login.protected') }}</p>
      <form class="space-y-3" @submit.prevent="emit('submit')">
        <Input
          v-model="password"
          type="password"
          autocomplete="current-password"
          :placeholder="$t('settings.login.passwordPlaceholder')"
          :disabled="pending"
        />
        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
        <Button type="submit" class="w-full" :disabled="pending || !password">
          {{ pending ? $t('settings.login.submitting') : $t('settings.login.submit') }}
        </Button>
      </form>
    </CardContent>
  </Card>


</template>
