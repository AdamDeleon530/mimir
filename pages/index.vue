<script setup lang="ts">
const password = ref('')
const error = ref('')
const loading = ref(false)
const router = useRouter()

async function submit() {
  if (!password.value) return
  loading.value = true
  error.value = ''
  try {
    await $fetch('/api/auth', { method: 'POST', body: { password: password.value } })
    await router.push('/dashboard')
  } catch {
    error.value = 'wrong password'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="min-h-dvh bg-fjord flex items-center justify-center px-6">
    <div class="w-full max-w-sm space-y-8 animate-fade-in">
      <div class="flex flex-col items-center">
        <img src="/favicon.svg" alt="The Nordic Nerd" class="w-14 h-14 animate-pulse-gold" />
        <h1 class="mt-6 font-serif text-[28px] tracking-[0.12em] text-bone">Mimir</h1>
        <p class="mt-1.5 font-mono text-[11px] tracking-[0.14em] uppercase" style="color: rgba(245,242,236,0.35);">
          The Nordic Nerd, operational
        </p>
      </div>

      <form @submit.prevent="submit" class="space-y-3">
        <input
          v-model="password"
          type="password"
          placeholder="password"
          autocomplete="current-password"
          autofocus
          class="w-full px-4 py-3 rounded-lg font-sans text-[14px] text-bone outline-none transition-all"
          style="
            background: rgba(255,255,255,0.03);
            border: 1px solid rgba(255,255,255,0.09);
          "
          :style="{ borderColor: password ? 'rgba(184,115,51,0.4)' : 'rgba(255,255,255,0.09)' }"
        />
        <button
          type="submit"
          :disabled="loading || !password"
          class="w-full px-4 py-3 rounded-lg font-mono text-[13px] tracking-wider uppercase transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          style="background: #B87333; color: #0F1B2D;"
          @mouseover="($event.target as HTMLElement).style.background = '#c98b4f'"
          @mouseleave="($event.target as HTMLElement).style.background = '#B87333'"
        >
          {{ loading ? 'checking…' : 'enter' }}
        </button>
        <p v-if="error" class="font-mono text-[11px] text-center" style="color: rgba(239,68,68,0.75);">{{ error }}</p>
      </form>
    </div>
  </div>
</template>
