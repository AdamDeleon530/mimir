<script setup lang="ts">
definePageMeta({ middleware: 'auth' })

const { messages, sending, send, lastReply } = useMimir()
const {
  listening, transcribing, speaking, transcript,
  startListening, stopListening, speak, stopSpeaking,
  isVoiceAvailable, voiceError,
} = useVoice()

const input = ref('')
const messagesRef = ref<HTMLElement | null>(null)
const voiceMode = ref(true)

// Live agency status for the side panels
interface AgencyStatus {
  asOf: string
  ops: { fileCount: number; syncedAt: string; isEmpty: boolean }
  money: { mtdRevenue: number; mrr: number; burnMTD: number; note?: string }
  pipeline: { stages: Array<{ name: string; count: number; value: number }>; note?: string }
  replies: { pending: number; note?: string }
  outbound: { bounceRate7d: number; complaintRate7d: number; inboxes: unknown[]; note?: string }
}
const { data: status, refresh: refreshStatus } = await useAsyncData<AgencyStatus>(
  'agency-status',
  () => $fetch('/api/agency-status'),
)

// Clock
const now = ref(new Date())
let clockId: ReturnType<typeof setInterval> | null = null
onMounted(() => { clockId = setInterval(() => { now.value = new Date() }, 1000) })
onUnmounted(() => { if (clockId) clearInterval(clockId) })

const timeStr = computed(() => now.value.toLocaleTimeString('en-US', { hour12: false }))
const dateStr = computed(() => now.value.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }))

// Reactor state derived from voice/chat state
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

// Scroll messages on update
watch(messages, async () => {
  await nextTick()
  messagesRef.value?.scrollTo({ top: messagesRef.value.scrollHeight, behavior: 'smooth' })
}, { deep: true })

// When Scribe returns a transcript, submit
watch(transcript, (t) => {
  if (t && !listening.value && !transcribing.value) {
    input.value = t
    void submit()
  }
})

// When Mimir replies, speak it if voice mode is on
watch(lastReply, (reply) => {
  if (reply && voiceMode.value) void speak(reply)
})

async function submit() {
  const text = input.value.trim()
  if (!text || sending.value) return
  input.value = ''
  await send(text)
}

function toggleMic() {
  // If Mimir is mid-speech, the mic button acts as an interrupt.
  if (speaking.value) {
    stopSpeaking()
    return
  }
  if (listening.value) stopListening()
  else void startListening()
}

function dollars(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime()
  if (!t) return 'never'
  const diffSec = Math.floor((Date.now() - t) / 1000)
  if (diffSec < 60) return `${diffSec}s ago`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  return `${Math.floor(diffSec / 86400)}d ago`
}
</script>

<template>
  <div class="jarvis">
    <!-- ============ HEADER ============ -->
    <header class="jarvis__header">
      <div class="brand">
        <span class="brand__rune">ᚾ</span>
        <span class="brand__name">M·I·M·I·R</span>
        <span :class="['brand__status', `brand__status--${reactorState}`]">
          <span class="brand__dot"></span>
          {{ reactorState === 'idle' ? 'online' : reactorState }}
        </span>
      </div>

      <div class="header__clock">
        <span class="header__time">{{ timeStr }}</span>
        <span class="header__sep">|</span>
        <span class="header__date">{{ dateStr }}</span>
      </div>

      <div class="header__meta">
        <span class="header__loc">Winter Haven · FL</span>
        <button @click="refreshStatus()" class="header__link" title="Refresh agency status">↻</button>
      </div>
    </header>

    <!-- ============ MAIN GRID ============ -->
    <main class="jarvis__grid">
      <!-- ====== LEFT PANELS ====== -->
      <aside class="jarvis__left">
        <section class="panel">
          <header class="panel__head">
            <span class="panel__title">Agency Pulse</span>
            <button @click="refreshStatus()" class="panel__refresh" title="Refresh">↻</button>
          </header>
          <div class="panel__body">
            <div class="metric metric--lead">
              <div class="metric__label">MTD Revenue</div>
              <div class="metric__value">{{ status ? dollars(status.money.mtdRevenue) : '—' }}</div>
            </div>
            <div class="metric-grid">
              <div class="metric">
                <div class="metric__label">MRR</div>
                <div class="metric__value">{{ status ? dollars(status.money.mrr) : '—' }}</div>
              </div>
              <div class="metric">
                <div class="metric__label">Burn</div>
                <div class="metric__value">{{ status ? dollars(status.money.burnMTD) : '—' }}</div>
              </div>
            </div>
          </div>
        </section>

        <section class="panel">
          <header class="panel__head">
            <span class="panel__title">Outbound</span>
          </header>
          <div class="panel__body">
            <div class="metric-grid">
              <div class="metric">
                <div class="metric__label">Bounce 7d</div>
                <div class="metric__value">{{ status ? (status.outbound.bounceRate7d.toFixed(1) + '%') : '—' }}</div>
              </div>
              <div class="metric">
                <div class="metric__label">Replies</div>
                <div class="metric__value">{{ status?.replies.pending ?? '—' }}</div>
              </div>
            </div>
            <div class="pipeline-mini">
              <div v-for="stage in status?.pipeline.stages ?? []" :key="stage.name" class="pipeline-mini__stage">
                <div class="pipeline-mini__count">{{ stage.count }}</div>
                <div class="pipeline-mini__name">{{ stage.name }}</div>
              </div>
            </div>
          </div>
        </section>

        <section class="panel">
          <header class="panel__head">
            <span class="panel__title">Ops Library</span>
          </header>
          <div class="panel__body">
            <div class="lib-status">
              <div class="lib-status__count">{{ status?.ops.fileCount ?? 0 }}</div>
              <div class="lib-status__label">files synced</div>
            </div>
            <div class="lib-status__when">
              {{ status?.ops.isEmpty
                ? 'run `pnpm sync-ops` to load'
                : 'synced ' + timeAgo(status?.ops.syncedAt ?? '') }}
            </div>
            <div :class="['lib-status__ok', status?.ops.isEmpty ? 'lib-status__ok--off' : 'lib-status__ok--on']">
              {{ status?.ops.isEmpty ? '○ context offline' : '● context active' }}
            </div>
          </div>
        </section>
      </aside>

      <!-- ====== CENTER REACTOR ====== -->
      <section class="jarvis__center">
        <MimirReactor :state="reactorState" />
        <div class="reactor-title">M·I·M·I·R</div>
        <div :class="['reactor-status', `reactor-status--${reactorState}`]">
          <span class="reactor-status__dot"></span>
          {{ statusLine }}
        </div>
        <div v-if="!messages.length && reactorState === 'idle'" class="reactor-hint">
          <em>"speak, and the watch will answer."</em>
          <div class="reactor-hint__prompts">
            try: <span>how's pipeline</span> · <span>what's in the copywriter agent</span> · <span>tier deliverables</span>
          </div>
        </div>
      </section>

      <!-- ====== RIGHT CONVERSATION ====== -->
      <aside class="jarvis__right">
        <header class="panel__head panel__head--full">
          <span class="panel__title">Conversation</span>
          <span class="panel__msg-count" v-if="messages.length">{{ messages.length }}</span>
        </header>
        <div ref="messagesRef" class="convo">
          <div v-if="!messages.length" class="convo__empty">
            Ask Mimir anything about the agency. He reads from your full ops library.
          </div>
          <div v-for="(msg, i) in messages" :key="i" :class="['msg', `msg--${msg.role}`]">
            <div v-if="msg.role === 'assistant'" class="msg__head">
              <span class="msg__rune">ᚾ</span> Mimir
            </div>
            <div v-else class="msg__head">You</div>
            <div class="msg__body">{{ msg.content }}</div>
          </div>
          <div v-if="sending" class="msg msg--assistant msg--pending">
            <div class="msg__head"><span class="msg__rune">ᚾ</span> Mimir</div>
            <div class="msg__body"><em>consulting the well…</em></div>
          </div>
        </div>
      </aside>
    </main>

    <!-- ============ BOTTOM CONTROLS ============ -->
    <footer class="jarvis__footer">
      <div v-if="voiceError" class="voice-error">{{ voiceError }}</div>

      <div class="controls">
        <button
          @click="voiceMode = !voiceMode"
          :class="['ctrl-btn', voiceMode ? 'ctrl-btn--on' : '']"
          :title="voiceMode ? 'Voice responses on' : 'Voice responses off'"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="ctrl-btn__icon">
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/>
          </svg>
        </button>

        <!-- Stop button — only visible while Mimir is speaking -->
        <button
          v-if="speaking"
          @click="stopSpeaking()"
          class="ctrl-btn ctrl-btn--stop"
          title="silence mimir"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="ctrl-btn__icon">
            <rect x="6" y="6" width="12" height="12" rx="1.5" />
          </svg>
        </button>

        <button
          v-if="isVoiceAvailable"
          @click="toggleMic"
          :class="[
            'ctrl-btn',
            'ctrl-btn--mic',
            listening ? 'ctrl-btn--recording' : '',
            speaking ? 'ctrl-btn--interrupt' : '',
          ]"
          :title="speaking ? 'tap to interrupt' : listening ? 'stop recording' : 'press to talk'"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="ctrl-btn__icon">
            <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
            <path d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.93V21a1 1 0 1 0 2 0v-3.07A7 7 0 0 0 19 11z"/>
          </svg>
        </button>

        <form @submit.prevent="submit" class="input-form">
          <input
            v-model="input"
            type="text"
            :placeholder="listening ? 'listening…' : transcribing ? 'transcribing…' : 'speak to mimir'"
            :disabled="transcribing"
            class="input-form__field"
          />
          <button type="submit" :disabled="!input.trim() || sending" class="ctrl-btn ctrl-btn--send">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="ctrl-btn__icon">
              <path d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a.993.993 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z"/>
            </svg>
          </button>
        </form>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.jarvis {
  --bg: #07090f;
  --bg-2: #0c1119;
  --panel: rgba(201, 166, 74, 0.04);
  --panel-border: rgba(201, 166, 74, 0.18);
  --panel-border-strong: rgba(201, 166, 74, 0.35);
  --gold: #c9a64a;
  --gold-bright: #d4b25c;
  --gold-dim: #8b7045;
  --text: #e8e2d0;
  --text-dim: rgba(232, 226, 208, 0.55);
  --text-faint: rgba(232, 226, 208, 0.3);
  --critred: #c43838;
  --critgreen: #3a8a3a;
  --bg-grad: radial-gradient(ellipse at 50% -20%, rgba(201, 166, 74, 0.08), transparent 60%),
             linear-gradient(180deg, #0a0e1a 0%, #07090f 100%);

  height: 100vh;
  background: var(--bg-grad);
  color: var(--text);
  font-family: 'Inter', system-ui, sans-serif;
  display: grid;
  grid-template-rows: 64px 1fr 96px;
  overflow: hidden;
}

/* === HEADER === */
.jarvis__header {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  padding: 0 24px;
  border-bottom: 1px solid var(--panel-border);
  background: linear-gradient(180deg, rgba(201, 166, 74, 0.04), transparent);
}
.brand { display: flex; align-items: center; gap: 12px; }
.brand__rune { color: var(--gold-bright); font-size: 22px; filter: drop-shadow(0 0 6px var(--gold)); }
.brand__name {
  font-family: 'Fraunces', Georgia, serif;
  font-size: 18px;
  letter-spacing: 0.25em;
  color: var(--text);
}
.brand__status {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px;
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  border: 1px solid var(--panel-border);
  border-radius: 999px;
  background: rgba(58, 138, 58, 0.08);
  color: var(--critgreen);
  margin-left: 8px;
}
.brand__status--listening,
.brand__status--speaking,
.brand__status--consulting,
.brand__status--transcribing {
  background: rgba(201, 166, 74, 0.1);
  color: var(--gold);
  border-color: var(--panel-border-strong);
}
.brand__dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 6px currentColor;
}
.header__clock {
  display: flex; align-items: center; gap: 14px;
  padding: 8px 16px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  background: var(--panel);
}
.header__time { color: var(--gold-bright); font-size: 16px; letter-spacing: 0.1em; }
.header__sep { color: var(--text-faint); }
.header__date { color: var(--text-dim); font-size: 13px; }
.header__meta {
  display: flex; align-items: center; justify-content: flex-end; gap: 16px;
}
.header__loc {
  font-size: 12px;
  letter-spacing: 0.12em;
  color: var(--text-dim);
}
.header__link {
  width: 32px; height: 32px;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text-dim);
  text-decoration: none;
  transition: all 0.2s;
}
.header__link:hover { color: var(--gold); border-color: var(--panel-border-strong); }

/* === GRID === */
.jarvis__grid {
  display: grid;
  grid-template-columns: 280px 1fr 360px;
  gap: 16px;
  padding: 16px 24px;
  min-height: 0;
}

/* === PANELS === */
.panel {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  overflow: hidden;
  position: relative;
}
.panel::before {
  content: '';
  position: absolute; top: 0; left: 0; width: 24px; height: 1px;
  background: var(--gold);
  box-shadow: 0 0 6px var(--gold);
}
.panel__head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--panel-border);
  background: linear-gradient(180deg, rgba(201, 166, 74, 0.06), transparent);
}
.panel__head--full {
  padding: 12px 16px;
}
.panel__title {
  font-size: 11px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--gold);
}
.panel__refresh {
  background: none; border: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
}
.panel__refresh:hover { color: var(--gold); }
.panel__msg-count {
  font-size: 11px;
  color: var(--text-dim);
  padding: 2px 8px;
  border: 1px solid var(--panel-border);
  border-radius: 999px;
}
.panel__body { padding: 14px; }

.metric { margin: 0; }
.metric--lead { margin-bottom: 12px; }
.metric__label {
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--text-faint);
  margin-bottom: 4px;
}
.metric__value {
  font-family: 'Fraunces', Georgia, serif;
  font-size: 20px;
  color: var(--gold-bright);
}
.metric--lead .metric__value { font-size: 28px; }
.metric-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.pipeline-mini {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--panel-border);
}
.pipeline-mini__stage { text-align: center; }
.pipeline-mini__count {
  font-family: 'Fraunces', Georgia, serif;
  font-size: 16px;
  color: var(--text);
}
.pipeline-mini__name {
  font-size: 9px;
  letter-spacing: 0.08em;
  color: var(--text-faint);
  text-transform: uppercase;
  margin-top: 2px;
  line-height: 1.2;
}

.lib-status {
  text-align: center;
  margin-bottom: 8px;
}
.lib-status__count {
  font-family: 'Fraunces', Georgia, serif;
  font-size: 36px;
  color: var(--gold-bright);
  line-height: 1;
}
.lib-status__label {
  font-size: 10px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--text-faint);
  margin-top: 4px;
}
.lib-status__when {
  font-size: 11px;
  color: var(--text-dim);
  text-align: center;
  margin: 8px 0;
}
.lib-status__ok {
  font-size: 10px;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  text-align: center;
  padding: 4px 0;
}
.lib-status__ok--on { color: var(--critgreen); }
.lib-status__ok--off { color: var(--gold-dim); }

.jarvis__left {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow-y: auto;
}

/* === CENTER === */
.jarvis__center {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  position: relative;
  min-height: 0;
}
.reactor-title {
  font-family: 'Fraunces', Georgia, serif;
  font-size: 28px;
  letter-spacing: 0.35em;
  color: var(--text);
  margin-top: -16px;
}
.reactor-status {
  display: inline-flex; align-items: center; gap: 8px;
  margin-top: 12px;
  padding: 6px 14px;
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  border: 1px solid var(--panel-border);
  border-radius: 999px;
  background: var(--panel);
  color: var(--text-dim);
}
.reactor-status--listening,
.reactor-status--speaking,
.reactor-status--consulting,
.reactor-status--transcribing {
  color: var(--gold);
  border-color: var(--panel-border-strong);
}
.reactor-status__dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 6px currentColor;
}
.reactor-hint {
  margin-top: 20px;
  font-size: 13px;
  color: var(--text-dim);
  font-family: 'Fraunces', Georgia, serif;
  font-style: italic;
}
.reactor-hint__prompts {
  margin-top: 10px;
  font-family: 'Inter', sans-serif;
  font-style: normal;
  font-size: 11px;
  color: var(--text-faint);
  letter-spacing: 0.05em;
}
.reactor-hint__prompts span { color: var(--gold); }

/* === RIGHT CONVO === */
.jarvis__right {
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  overflow: hidden;
  min-height: 0;
}
.jarvis__right::before {
  content: '';
  position: absolute; top: 0; left: 0; width: 24px; height: 1px;
  background: var(--gold);
  box-shadow: 0 0 6px var(--gold);
}
.convo {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.convo__empty {
  color: var(--text-faint);
  font-size: 13px;
  text-align: center;
  padding: 32px 16px;
  font-style: italic;
}
.msg { font-size: 13.5px; line-height: 1.55; }
.msg__head {
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--text-faint);
  margin-bottom: 4px;
}
.msg__rune { color: var(--gold); margin-right: 4px; }
.msg__body {
  padding: 10px 12px;
  border-radius: 8px;
  white-space: pre-wrap;
}
.msg--user .msg__head { color: var(--gold-bright); }
.msg--user .msg__body {
  background: rgba(201, 166, 74, 0.08);
  border: 1px solid var(--panel-border);
  color: var(--text);
}
.msg--assistant .msg__body {
  background: rgba(255, 255, 255, 0.02);
  border-left: 2px solid var(--gold);
  color: var(--text);
}
.msg--pending .msg__body { color: var(--text-dim); }

/* === FOOTER === */
.jarvis__footer {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  padding: 0 24px 16px;
  border-top: 1px solid var(--panel-border);
}
.voice-error {
  max-width: 600px;
  width: 100%;
  margin: 8px auto;
  padding: 6px 12px;
  font-size: 11px;
  color: var(--critred);
  background: rgba(196, 56, 56, 0.08);
  border: 1px solid rgba(196, 56, 56, 0.3);
  border-radius: 6px;
  text-align: center;
}
.controls {
  display: flex; align-items: center; gap: 12px;
  max-width: 700px;
  width: 100%;
}
.ctrl-btn {
  width: 48px; height: 48px;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--panel-border);
  border-radius: 50%;
  background: var(--panel);
  color: var(--text-dim);
  cursor: pointer;
  transition: all 0.2s;
}
.ctrl-btn:hover { color: var(--gold); border-color: var(--panel-border-strong); }
.ctrl-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.ctrl-btn__icon { width: 20px; height: 20px; }
.ctrl-btn--on { color: var(--gold); border-color: var(--panel-border-strong); }
.ctrl-btn--mic.ctrl-btn--recording {
  background: var(--critred);
  color: white;
  border-color: var(--critred);
  animation: ctrl-pulse 1.4s ease-in-out infinite;
}
.ctrl-btn--stop {
  background: var(--critred);
  color: white;
  border-color: var(--critred);
  animation: ctrl-pulse 1.6s ease-in-out infinite;
}
.ctrl-btn--stop:hover {
  background: #e54545;
  border-color: #e54545;
  color: white;
}
.ctrl-btn--interrupt {
  border-color: var(--gold);
  color: var(--gold);
}
.ctrl-btn--send {
  background: var(--gold);
  color: #0a0e1a;
  border-color: var(--gold);
}
.ctrl-btn--send:hover { background: var(--gold-bright); color: #0a0e1a; }
.input-form {
  flex: 1;
  display: flex; align-items: center; gap: 12px;
}
.input-form__field {
  flex: 1;
  height: 48px;
  padding: 0 18px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--panel-border);
  border-radius: 999px;
  color: var(--text);
  font-family: 'Inter', sans-serif;
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s;
}
.input-form__field:focus {
  border-color: var(--panel-border-strong);
}
.input-form__field::placeholder { color: var(--text-faint); }
.input-form__field:disabled { opacity: 0.6; }

@keyframes ctrl-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(196, 56, 56, 0.5); }
  50%      { box-shadow: 0 0 0 10px rgba(196, 56, 56, 0); }
}

/* Custom scrollbars */
.convo::-webkit-scrollbar,
.jarvis__left::-webkit-scrollbar { width: 6px; }
.convo::-webkit-scrollbar-track,
.jarvis__left::-webkit-scrollbar-track { background: transparent; }
.convo::-webkit-scrollbar-thumb,
.jarvis__left::-webkit-scrollbar-thumb {
  background: rgba(201, 166, 74, 0.15);
  border-radius: 3px;
}

/* Responsive — collapse panels on small screens */
@media (max-width: 1100px) {
  .jarvis__grid { grid-template-columns: 240px 1fr 320px; }
}
@media (max-width: 900px) {
  .jarvis__grid { grid-template-columns: 1fr; }
  .jarvis__left, .jarvis__right { display: none; }
}
</style>
