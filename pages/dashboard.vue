<script setup lang="ts">
definePageMeta({ middleware: 'auth' })

const { messages, sending, send, lastReply, clear: clearConversation, loadMemory } = useMimir()
const {
  listening, transcribing, speaking, transcript,
  startListening, stopListening, speak, stopSpeaking,
  isVoiceAvailable, voiceError,
} = useVoice()

const input = ref('')
const messagesRef = ref<HTMLElement | null>(null)
const voiceMode = ref(true)
const drawerOpen = ref(false)

interface AgencyStatus {
  asOf: string
  ops: { fileCount: number; syncedAt: string; isEmpty: boolean }
  money: { mtdRevenue: number | null; mrr: number | null; burnMTD: number | null; note?: string }
  pipeline: { stages: Array<{ name: string; count: number; value: number }>; note?: string }
  replies: { pending: number; note?: string }
  outbound: { bounceRate7d: number | null; complaintRate7d: number | null; inboxes: unknown[]; note?: string }
}

const { data: status, refresh: refreshStatus } = await useAsyncData<AgencyStatus>(
  'agency-status',
  () => $fetch('/api/agency-status'),
)

// Clock
const now = ref(new Date())
let clockId: ReturnType<typeof setInterval> | null = null

// Status freshness
const lastRefreshAt = ref(new Date())
const statusError = ref<string | null>(null)
let refreshId: ReturnType<typeof setInterval> | null = null

async function autoRefresh(): Promise<void> {
  try {
    await refreshStatus()
    lastRefreshAt.value = new Date()
    statusError.value = null
  } catch (err) {
    statusError.value = err instanceof Error ? err.message : 'refresh failed'
  }
}

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && drawerOpen.value) drawerOpen.value = false
}

onMounted(() => {
  clockId = setInterval(() => { now.value = new Date() }, 1000)
  refreshId = setInterval(autoRefresh, 60_000)
  document.addEventListener('keydown', handleKeydown)
  void loadMemory()
})

onUnmounted(() => {
  if (clockId) clearInterval(clockId)
  if (refreshId) clearInterval(refreshId)
  document.removeEventListener('keydown', handleKeydown)
})

const statusAgeSec = computed(() => Math.floor((now.value.getTime() - lastRefreshAt.value.getTime()) / 1000))
const statusIsStale = computed(() => statusAgeSec.value > 300)
const timeStr = computed(() => now.value.toLocaleTimeString('en-US', { hour12: false }))
const dateStr = computed(() => now.value.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))

type ReactorState = 'idle' | 'listening' | 'transcribing' | 'consulting' | 'speaking'
const reactorState = computed<ReactorState>(() => {
  if (speaking.value) return 'speaking'
  if (sending.value) return 'consulting'
  if (transcribing.value) return 'transcribing'
  if (listening.value) return 'listening'
  return 'idle'
})

const statusLine = computed(() => {
  switch (reactorState.value) {
    case 'listening':    return 'listening…'
    case 'transcribing': return 'transcribing…'
    case 'consulting':   return 'consulting the well…'
    case 'speaking':     return 'speaking…'
    default:             return 'the watch is silent'
  }
})

// Scroll conversation to bottom on new messages
watch(messages, async () => {
  await nextTick()
  messagesRef.value?.scrollTo({ top: messagesRef.value.scrollHeight, behavior: 'smooth' })
}, { deep: true })

// Auto-submit when voice transcript arrives
watch(transcript, (t) => {
  if (t && !listening.value && !transcribing.value) {
    input.value = t
    void submit()
  }
})

// Speak reply if voice mode is on
watch(lastReply, (reply) => {
  if (reply && voiceMode.value) void speak(reply)
})

async function submit(): Promise<void> {
  const text = input.value.trim()
  if (!text || sending.value) return
  input.value = ''
  await send(text)
}

function toggleMic(): void {
  if (speaking.value) { stopSpeaking(); return }
  if (listening.value) stopListening()
  else void startListening()
}

// Hint suggestions for empty conversation state
const hints = ['how\'s pipeline', 'what\'s in the copywriter agent', 'tier deliverables'] as const
</script>

<template>
  <div class="root">

    <!-- ══════════ HEADER ══════════ -->
    <header class="header">
      <!-- Brand -->
      <div class="flex items-center gap-2.5">
        <span class="rune" aria-hidden="true">ᚾ</span>
        <span class="font-serif text-[15px] tracking-[0.28em]" style="color: #F5F2EC;">M·I·M·I·R</span>
      </div>

      <!-- Nav chips -->
      <nav class="flex items-center gap-1" aria-label="Mimir navigation">
        <NuxtLink to="/leads"     class="chip">leads</NuxtLink>
        <NuxtLink to="/markets"   class="chip">markets</NuxtLink>
        <NuxtLink to="/briefings" class="chip">briefings</NuxtLink>
      </nav>

      <!-- Reactor state indicator -->
      <div class="flex items-center gap-2" aria-live="polite" aria-atomic="true">
        <span
          :class="['state-dot', reactorState !== 'idle' ? 'state-dot--active' : '']"
          aria-hidden="true"
        ></span>
        <span class="font-mono text-[10px] tracking-wider hidden sm:block" style="color: rgba(245,242,236,0.38);">
          {{ reactorState === 'idle' ? 'online' : reactorState }}
        </span>
      </div>
    </header>

    <!-- ══════════ MAIN ══════════ -->
    <main class="main">

      <!-- Drawer (fixed, manages its own positioning) -->
      <MimirDrawer
        v-model="drawerOpen"
        :status="status"
        @refresh="autoRefresh"
      />

      <!-- Center surface: reactor → conversation -->
      <div class="center">

        <!-- Reactor section (flex-none — stays pinned at top) -->
        <section class="reactor-section" aria-label="Mimir status">
          <div class="reactor-container">
            <MimirReactor :state="reactorState" />
          </div>

          <h1 class="font-serif text-[20px] tracking-[0.32em] -mt-2" style="color: rgba(245,242,236,0.88);">
            M·I·M·I·R
          </h1>

          <div :class="['status-pill', reactorState !== 'idle' && 'status-pill--active']" role="status">
            <span class="w-1 h-1 rounded-full bg-current shrink-0" aria-hidden="true"></span>
            {{ statusLine }}
          </div>

          <!-- Empty state hint (no messages, idle) -->
          <div v-if="!messages.length && reactorState === 'idle'" class="hint-block">
            <p class="font-serif italic text-[13px]" style="color: rgba(245,242,236,0.28);">
              "speak, and the watch will answer."
            </p>
            <p class="mt-3 font-mono text-[10px] tracking-wide flex flex-wrap items-center justify-center gap-x-2 gap-y-1" style="color: rgba(245,242,236,0.2);">
              <template v-for="(hint, i) in hints" :key="hint">
                <button type="button" @click="input = hint" class="hint-btn">{{ hint }}</button>
                <span v-if="i < hints.length - 1" aria-hidden="true" style="color: rgba(245,242,236,0.12);">·</span>
              </template>
            </p>
          </div>
        </section>

        <!-- Conversation (flex-1, scrolls independently) -->
        <section
          ref="messagesRef"
          class="convo"
          aria-label="Conversation with Mimir"
          aria-live="polite"
          aria-relevant="additions"
        >
          <div class="convo-inner">
            <div
              v-for="(msg, i) in messages"
              :key="i"
              class="msg-row"
            >
              <!-- Role label -->
              <p :class="['msg-label', msg.role === 'user' ? 'msg-label--user' : '']">
                <template v-if="msg.role === 'assistant'">
                  <span aria-hidden="true" style="color: rgba(184,115,51,0.6); margin-right: 4px;">ᚾ</span>Mimir
                </template>
                <template v-else>You</template>
              </p>

              <!-- Tool trace -->
              <ul v-if="msg.toolUse?.length" class="tool-list" aria-label="Tools Mimir called">
                <li
                  v-for="(tu, ti) in msg.toolUse"
                  :key="ti"
                  :class="['tool-item', tu.state === 'running' ? 'tool-item--running' : 'tool-item--done']"
                >
                  <span class="tool-icon" aria-hidden="true">{{ tu.state === 'running' ? '◌' : '✓' }}</span>
                  <span class="tool-name">{{ tu.name }}</span>
                </li>
              </ul>

              <!-- Message body -->
              <div
                v-if="msg.content"
                :class="['msg-body', msg.role === 'user' ? 'msg-body--user' : 'msg-body--assistant']"
              >{{ msg.content }}</div>

              <!-- Pending placeholder -->
              <p
                v-else-if="msg.role === 'assistant' && sending && i === messages.length - 1"
                class="font-serif italic text-[13px] mt-1"
                style="color: rgba(245,242,236,0.28);"
                aria-label="Mimir is thinking"
              >consulting the well…</p>
            </div>

            <!-- Clear button (appears after a few messages to avoid noise) -->
            <div v-if="messages.length > 3" class="flex justify-center pt-8 pb-2">
              <button @click="clearConversation()" class="clear-btn">clear conversation</button>
            </div>
          </div>
        </section>

      </div>
    </main>

    <!-- ══════════ FOOTER ══════════ -->
    <footer class="footer">

      <!-- Voice error banner -->
      <div v-if="voiceError" class="voice-error" role="alert">{{ voiceError }}</div>

      <!-- Input bar -->
      <form @submit.prevent="submit" class="input-bar">

        <!-- Voice mode toggle chip -->
        <button
          type="button"
          @click="voiceMode = !voiceMode"
          :class="['voice-chip', voiceMode ? 'voice-chip--on' : '']"
          :title="voiceMode ? 'Voice responses on — click to mute' : 'Voice responses off — click to enable'"
          :aria-pressed="voiceMode"
          aria-label="Toggle voice responses"
        >
          <!-- Speaker on -->
          <svg v-if="voiceMode" viewBox="0 0 24 24" fill="currentColor" class="w-3 h-3" aria-hidden="true">
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/>
          </svg>
          <!-- Speaker off -->
          <svg v-else viewBox="0 0 24 24" fill="currentColor" class="w-3 h-3" aria-hidden="true">
            <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
          </svg>
          <span class="text-[9px] font-mono tracking-wider uppercase select-none">
            {{ voiceMode ? 'voice' : 'muted' }}
          </span>
        </button>

        <!-- Text input -->
        <input
          v-model="input"
          type="text"
          :placeholder="listening ? 'listening…' : transcribing ? 'transcribing…' : 'ask mimir anything…'"
          :disabled="transcribing"
          class="input-field"
          aria-label="Message to Mimir"
          autocomplete="off"
        />

        <!-- Stop (when Mimir is speaking) -->
        <button
          v-if="speaking"
          type="button"
          @click="stopSpeaking()"
          class="ctrl-btn ctrl-btn--stop"
          title="Silence Mimir"
          aria-label="Stop Mimir from speaking"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        </button>

        <!-- Mic (when voice mode on and not speaking) -->
        <button
          v-else-if="isVoiceAvailable && voiceMode"
          type="button"
          @click="toggleMic"
          :class="['ctrl-btn', listening ? 'ctrl-btn--recording' : '']"
          :title="listening ? 'Stop recording' : 'Press to talk'"
          :aria-label="listening ? 'Stop recording' : 'Start voice input'"
          :aria-pressed="listening"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4" aria-hidden="true">
            <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
            <path d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.93V21a1 1 0 1 0 2 0v-3.07A7 7 0 0 0 19 11z"/>
          </svg>
        </button>

        <!-- Send (when there's text and not already sending) -->
        <button
          v-if="input.trim() && !sending"
          type="submit"
          class="ctrl-btn ctrl-btn--send"
          title="Send message"
          aria-label="Send message"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4" aria-hidden="true">
            <path d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a.993.993 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z"/>
          </svg>
        </button>

      </form>

      <!-- Status strip -->
      <div class="status-strip" aria-label="System status">
        <span class="font-mono tabular-nums">{{ timeStr }}</span>
        <span class="strip-sep" aria-hidden="true"></span>
        <span>Winter Haven · FL</span>
        <span class="strip-sep" aria-hidden="true"></span>
        <span :class="statusIsStale ? 'stale' : ''">
          {{ statusError ? '⚠ stale' : statusAgeSec < 60 ? `${statusAgeSec}s ago` : `${Math.floor(statusAgeSec / 60)}m ago` }}
        </span>
        <button
          type="button"
          @click="autoRefresh()"
          class="strip-refresh"
          title="Refresh agency status"
          aria-label="Refresh agency status"
        >↻</button>
        <span class="strip-sep hidden sm:block" aria-hidden="true"></span>
        <span class="hidden sm:block">{{ dateStr }}</span>
      </div>

    </footer>

  </div>
</template>

<style scoped>
/* ── Root ── */
.root {
  height: 100dvh;
  display: flex;
  flex-direction: column;
  background: #0F1B2D;
  color: #F5F2EC;
  font-family: 'Inter', system-ui, sans-serif;
  overflow: hidden;
}

/* ── Header ── */
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 56px;
  padding: 0 24px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  background: linear-gradient(180deg, rgba(255,255,255,0.015) 0%, transparent 100%);
  flex-shrink: 0;
}

.rune {
  font-size: 18px;
  color: #B87333;
  filter: drop-shadow(0 0 6px rgba(184,115,51,0.4));
}

/* ── Nav chips ── */
.chip {
  display: inline-block;
  padding: 5px 12px;
  border-radius: 6px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: rgba(245,242,236,0.35);
  text-decoration: none;
  border: 1px solid transparent;
  transition: color 150ms, background 150ms, border-color 150ms;
}
.chip:hover {
  color: rgba(245,242,236,0.7);
  background: rgba(255,255,255,0.04);
}
.chip.router-link-active {
  color: #B87333;
  background: rgba(184,115,51,0.08);
  border-color: rgba(184,115,51,0.22);
}

/* ── State dot ── */
.state-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgba(74,222,128,0.6);
  box-shadow: 0 0 5px rgba(74,222,128,0.35);
  flex-shrink: 0;
}
.state-dot--active {
  background: #B87333;
  box-shadow: 0 0 6px rgba(184,115,51,0.5);
  animation: dot-pulse 1.4s ease-in-out infinite;
}

/* ── Main ── */
.main {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  position: relative;
}

/* ── Center surface ── */
.center {
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
  overflow: hidden;
}

/* ── Reactor section ── */
.reactor-section {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 36px;
  padding-bottom: 16px;
  width: 100%;
}

.reactor-container {
  width: clamp(180px, 22vw, 280px);
}

/* ── Status pill ── */
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-top: 13px;
  padding: 5px 16px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: rgba(245,242,236,0.25);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 999px;
}
.status-pill--active {
  color: #B87333;
  border-color: rgba(184,115,51,0.22);
  background: rgba(184,115,51,0.04);
}

/* ── Empty state hint ── */
.hint-block {
  margin-top: 22px;
  text-align: center;
  padding: 0 24px;
}
.hint-btn {
  color: rgba(184,115,51,0.45);
  background: none;
  border: none;
  cursor: pointer;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  padding: 0;
  transition: color 150ms;
}
.hint-btn:hover { color: #B87333; }

/* ── Conversation ── */
.convo {
  flex: 1;
  overflow-y: auto;
  width: 100%;
  min-height: 0;
  scrollbar-width: thin;
  scrollbar-color: rgba(184,115,51,0.1) transparent;
}
.convo::-webkit-scrollbar { width: 4px; }
.convo::-webkit-scrollbar-thumb { background: rgba(184,115,51,0.12); border-radius: 2px; }
.convo::-webkit-scrollbar-track { background: transparent; }

.convo-inner {
  max-width: 672px; /* matches footer input-bar max-width */
  margin: 0 auto;
  padding: 8px 24px 32px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* ── Message row ── */
.msg-row {
  animation: fade-up 220ms ease-out both;
}

.msg-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: rgba(245,242,236,0.28);
  margin-bottom: 7px;
}
.msg-label--user { color: rgba(184,115,51,0.75); }

.msg-body {
  font-size: 14px;
  line-height: 1.7;
  white-space: pre-wrap;
}
.msg-body--user {
  padding: 11px 15px;
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.07);
  border-radius: 8px;
  color: rgba(245,242,236,0.82);
}
.msg-body--assistant {
  padding-left: 15px;
  border-left: 2px solid rgba(184,115,51,0.28);
  color: rgba(245,242,236,0.68);
}

/* ── Tool trace ── */
.tool-list {
  list-style: none;
  padding: 0;
  margin: 0 0 8px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.tool-item {
  display: flex;
  align-items: center;
  gap: 7px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
}
.tool-item--running {
  color: rgba(184,115,51,0.75);
  animation: tool-blink 1s ease-in-out infinite;
}
.tool-item--done { color: rgba(245,242,236,0.22); }
.tool-icon { width: 12px; text-align: center; flex-shrink: 0; }
.tool-name { font-weight: 500; }

/* ── Clear button ── */
.clear-btn {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgba(245,242,236,0.18);
  background: none;
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 4px;
  padding: 5px 14px;
  cursor: pointer;
  transition: color 150ms, border-color 150ms;
}
.clear-btn:hover {
  color: rgba(245,242,236,0.45);
  border-color: rgba(255,255,255,0.1);
}

/* ── Footer ── */
.footer {
  flex-shrink: 0;
  border-top: 1px solid rgba(255,255,255,0.06);
}

/* ── Voice error ── */
.voice-error {
  max-width: 672px;
  margin: 10px auto 0;
  padding: 6px 16px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: rgba(239,68,68,0.75);
  background: rgba(239,68,68,0.05);
  border: 1px solid rgba(239,68,68,0.15);
  border-radius: 6px;
  text-align: center;
}

/* ── Input bar ── */
.input-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 672px;
  margin: 0 auto;
  padding: 14px 24px;
}

/* ── Voice chip ── */
.voice-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.08);
  background: rgba(255,255,255,0.02);
  color: rgba(245,242,236,0.22);
  cursor: pointer;
  flex-shrink: 0;
  transition: color 150ms, border-color 150ms, background 150ms;
}
.voice-chip:hover {
  color: rgba(245,242,236,0.5);
  border-color: rgba(255,255,255,0.12);
}
.voice-chip--on {
  color: #B87333;
  border-color: rgba(184,115,51,0.28);
  background: rgba(184,115,51,0.06);
}

/* ── Input field ── */
.input-field {
  flex: 1;
  height: 44px;
  padding: 0 16px;
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.09);
  border-radius: 10px;
  color: #F5F2EC;
  font-family: 'Inter', system-ui, sans-serif;
  font-size: 14px;
  outline: none;
  transition: border-color 150ms, box-shadow 150ms;
}
.input-field::placeholder { color: rgba(245,242,236,0.18); }
.input-field:focus {
  border-color: rgba(184,115,51,0.35);
  box-shadow: 0 0 0 3px rgba(184,115,51,0.06);
}
.input-field:disabled { opacity: 0.45; cursor: not-allowed; }

/* ── Control buttons ── */
.ctrl-btn {
  width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: 1px solid rgba(255,255,255,0.09);
  border-radius: 50%;
  background: rgba(255,255,255,0.03);
  color: rgba(245,242,236,0.38);
  cursor: pointer;
  transition: all 150ms;
}
.ctrl-btn:hover {
  color: #B87333;
  border-color: rgba(184,115,51,0.3);
  background: rgba(184,115,51,0.05);
}

.ctrl-btn--recording {
  background: rgba(185,28,28,0.2);
  color: rgba(252,165,165,0.85);
  border-color: rgba(220,38,38,0.3);
  animation: record-pulse 1.4s ease-in-out infinite;
}

.ctrl-btn--stop {
  background: rgba(185,28,28,0.1);
  color: rgba(252,165,165,0.7);
  border-color: rgba(220,38,38,0.2);
}
.ctrl-btn--stop:hover {
  background: rgba(185,28,28,0.25);
  border-color: rgba(220,38,38,0.4);
  color: rgba(252,165,165,1);
}

.ctrl-btn--send {
  background: #B87333;
  color: #0F1B2D;
  border-color: #B87333;
}
.ctrl-btn--send:hover {
  background: #c98b4f;
  border-color: #c98b4f;
  color: #0F1B2D;
}

/* ── Status strip ── */
.status-strip {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 5px 24px 10px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: rgba(245,242,236,0.18);
  letter-spacing: 0.04em;
}
.strip-sep {
  display: inline-block;
  width: 1px;
  height: 9px;
  background: rgba(245,242,236,0.1);
  border-radius: 1px;
}
.strip-refresh {
  background: none;
  border: none;
  color: rgba(245,242,236,0.18);
  cursor: pointer;
  transition: color 150ms;
  padding: 0;
  font-size: inherit;
}
.strip-refresh:hover { color: #B87333; }
.stale { color: rgba(251,146,60,0.7); }

/* ── Keyframes ── */
@keyframes fade-up {
  from { opacity: 0; transform: translateY(5px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes tool-blink {
  0%, 100% { opacity: 0.45; }
  50%       { opacity: 1; }
}
@keyframes record-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(220,38,38,0.2); }
  50%      { box-shadow: 0 0 0 6px rgba(220,38,38,0); }
}
@keyframes dot-pulse {
  0%, 100% { opacity: 0.65; }
  50%       { opacity: 1; }
}

/* ── Responsive ── */
@media (max-width: 640px) {
  .header      { padding: 0 16px; }
  .convo-inner { padding: 8px 16px 24px; }
  .input-bar   { padding: 10px 16px; }
  .status-strip { padding: 4px 16px 8px; }
}

/* ── Reduced motion ── */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0ms !important;
    transition-duration: 0ms !important;
  }
}
</style>
