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
  } catch (e) {
    error.value = 'wrong password'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center px-6">
    <div class="w-full max-w-sm space-y-8 animate-fade-in">
      <div class="flex flex-col items-center">
        <img src="/favicon.svg" alt="The Nordic Nerd" class="w-16 h-16 animate-pulse-gold" />
        <h1 class="mt-6 font-serif text-3xl text-offwhite">Mimir</h1>
        <p class="mt-2 text-sm text-offwhite/50">The Nordic Nerd, operational</p>
      </div>

      <form @submit.prevent="submit" class="space-y-3">
        <input
          v-model="password"
          type="password"
          placeholder="password"
          autocomplete="current-password"
          autofocus
          class="w-full px-4 py-3 bg-white/[0.03] border border-white/10 rounded-lg text-offwhite placeholder:text-offwhite/30 focus:outline-none focus:border-gold/60 transition-colors"
        />
        <button
          type="submit"
          :disabled="loading || !password"
          class="w-full px-4 py-3 bg-gold text-matte rounded-lg font-medium hover:bg-gold/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {{ loading ? 'checking...' : 'enter' }}
        </button>
        <p v-if="error" class="text-critred text-sm text-center">{{ error }}</p>
      </form>
    </div>
  </div>
</template>
