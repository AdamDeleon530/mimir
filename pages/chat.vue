<script setup lang="ts">
definePageMeta({ middleware: 'auth' })

const { messages, sending, send, lastReply } = useMimir()
const { listening, speaking, transcript, startListening, stopListening, speak, isVoiceAvailable } = useVoice()

const input = ref('')
const scrollRef = ref<HTMLElement | null>(null)
const voiceMode = ref(true)

watch(messages, async () => {
  await nextTick()
  scrollRef.value?.scrollTo({ top: scrollRef.value.scrollHeight, behavior: 'smooth' })
}, { deep: true })

// When voice transcript completes, send it
watch(transcript, (t) => {
  if (t && !listening.value) {
    input.value = t
    submit()
  }
})

// When Mimir replies, speak it (if voice mode is on)
watch(lastReply, (reply) => {
  if (reply && voiceMode.value) {
    void speak(reply)
  }
})

async function submit() {
  const text = input.value.trim()
  if (!text || sending.value) return
  input.value = ''
  await send(text)
}

function toggleMic() {
  if (listening.value) stopListening()
  else startListening()
}
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <!-- Header -->
    <header class="flex items-center justify-between px-6 py-4 border-b border-white/5">
      <NuxtLink to="/dashboard" class="flex items-center gap-2 text-offwhite/60 hover:text-offwhite transition-colors">
        <span class="text-sm">← dashboard</span>
      </NuxtLink>
      <div class="flex items-center gap-2">
        <img src="/favicon.svg" alt="" class="w-6 h-6" :class="{ 'animate-pulse-gold': sending || speaking }" />
        <span class="font-serif text-lg">Mimir</span>
      </div>
      <button
        @click="voiceMode = !voiceMode"
        :class="voiceMode ? 'text-gold' : 'text-offwhite/40'"
        class="text-xs px-3 py-1.5 border border-white/10 rounded hover:border-white/20 transition-colors"
      >
        {{ voiceMode ? 'voice on' : 'voice off' }}
      </button>
    </header>

    <!-- Messages -->
    <div ref="scrollRef" class="flex-1 overflow-y-auto scrollbar-thin px-6 py-8">
      <div class="max-w-2xl mx-auto space-y-6">
        <div v-if="!messages.length" class="text-center py-20 animate-fade-in">
          <div class="text-offwhite/30 font-serif italic mb-2">"speak, and the watch will answer."</div>
          <div class="text-xs text-offwhite/30">try: <span class="text-gold/60">how's pipeline</span> · <span class="text-gold/60">what's MTD revenue</span> · <span class="text-gold/60">any pending replies</span></div>
        </div>

        <div v-for="(msg, i) in messages" :key="i" class="animate-fade-in">
          <div v-if="msg.role === 'user'" class="flex justify-end">
            <div class="max-w-[80%] bg-gold/15 text-offwhite px-4 py-2.5 rounded-2xl rounded-br-md">
              {{ msg.content }}
            </div>
          </div>
          <div v-else class="flex gap-3">
            <img src="/favicon.svg" alt="" class="w-6 h-6 mt-1 shrink-0" />
            <div class="max-w-[80%] text-offwhite/90 whitespace-pre-wrap leading-relaxed">{{ msg.content }}</div>
          </div>
        </div>

        <div v-if="sending" class="flex gap-3 animate-fade-in">
          <img src="/favicon.svg" alt="" class="w-6 h-6 mt-1 shrink-0 animate-pulse-gold" />
          <div class="text-offwhite/40 text-sm italic">consulting...</div>
        </div>
      </div>
    </div>

    <!-- Input -->
    <div class="border-t border-white/5 px-6 py-4">
      <form @submit.prevent="submit" class="max-w-2xl mx-auto flex gap-2 items-end">
        <button
          v-if="isVoiceAvailable"
          type="button"
          @click="toggleMic"
          :class="listening ? 'bg-critred text-offwhite animate-pulse' : 'bg-white/5 text-offwhite/60 hover:text-offwhite'"
          class="w-11 h-11 shrink-0 rounded-full flex items-center justify-center transition-colors"
          :title="listening ? 'stop listening' : 'press to talk'"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-5 h-5">
            <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
            <path d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.93V21a1 1 0 1 0 2 0v-3.07A7 7 0 0 0 19 11z"/>
          </svg>
        </button>

        <textarea
          v-model="input"
          @keydown.enter.exact.prevent="submit"
          :placeholder="listening ? 'listening...' : 'ask mimir'"
          rows="1"
          class="flex-1 bg-white/[0.03] border border-white/10 rounded-2xl px-4 py-2.5 text-offwhite placeholder:text-offwhite/30 focus:outline-none focus:border-gold/60 resize-none transition-colors"
        />

        <button
          type="submit"
          :disabled="!input.trim() || sending"
          class="w-11 h-11 shrink-0 bg-gold text-matte rounded-full flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed hover:bg-gold/90 transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-5 h-5">
            <path d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a.993.993 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z"/>
          </svg>
        </button>
      </form>
    </div>
  </div>
</template>
