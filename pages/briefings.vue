<script setup lang="ts">
definePageMeta({ middleware: 'auth' })

interface Briefing {
  id: string
  generated_at: string
  date_local: string
  body: string
  facts: {
    queue: { total: number; active: number; due_today: number; sent_today_by_inbox: Record<string, number> }
    inboxes: Array<{ email: string; sent_today: number; cap: number; can_send: boolean }>
    ops_files: number
    ops_synced_at: string
  }
  tokens_used?: { input: number; output: number }
}

const { data, refresh, pending } = await useFetch<{ briefings: Briefing[] }>('/api/briefings', {
  query: { limit: 30 },
})

const generating = ref(false)
async function generateNow() {
  generating.value = true
  try {
    await $fetch('/api/run-morning-briefing', { method: 'POST' })
    await refresh()
  } finally {
    generating.value = false
  }
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime()
  if (!t) return ''
  const sec = Math.floor((Date.now() - t) / 1000)
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86400)}d ago`
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <NuxtLink to="/dashboard" class="back-link">← dashboard</NuxtLink>
      <h1 class="page-title">
        <span class="rune" aria-hidden="true">ᚾ</span> Daily Briefings
      </h1>
      <button
        @click="generateNow"
        :disabled="generating"
        class="action-btn"
        :aria-busy="generating"
      >
        {{ generating ? 'consulting…' : 'generate now' }}
      </button>
    </header>

    <main class="page-content">
      <div v-if="pending && !data" class="state-empty">loading the log…</div>
      <div v-else-if="!data?.briefings?.length" class="state-empty">
        no briefings yet. the watch begins on the first weekday morning.
      </div>

      <ol v-else class="brief-list">
        <li v-for="b in data.briefings" :key="b.id" class="brief">
          <header class="brief__head">
            <span class="brief__date">{{ b.date_local }}</span>
            <span class="brief__when">{{ timeAgo(b.generated_at) }}</span>
          </header>
          <p class="brief__body">{{ b.body }}</p>
          <footer class="brief__foot">
            <span>
              queue {{ b.facts.queue.total }}
              · active {{ b.facts.queue.active }}
              · due today {{ b.facts.queue.due_today }}
            </span>
            <span v-if="b.tokens_used">{{ b.tokens_used.input + b.tokens_used.output }} tokens</span>
          </footer>
        </li>
      </ol>
    </main>
  </div>
</template>

<style scoped>
.page {
  min-height: 100dvh;
  background: #0F1B2D;
  color: #F5F2EC;
  font-family: 'Inter', system-ui, sans-serif;
}

/* ── Header ── */
.page-header {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 16px;
  padding: 16px 24px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  background: linear-gradient(180deg, rgba(255,255,255,0.015), transparent);
  position: sticky;
  top: 0;
  z-index: 10;
  backdrop-filter: blur(12px);
}

.back-link {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: rgba(245,242,236,0.38);
  text-decoration: none;
  padding: 5px 10px;
  border-radius: 5px;
  border: 1px solid transparent;
  transition: color 150ms, border-color 150ms, background 150ms;
  white-space: nowrap;
}
.back-link:hover {
  color: #B87333;
  border-color: rgba(184,115,51,0.2);
  background: rgba(184,115,51,0.05);
}

.page-title {
  font-family: 'Fraunces', Georgia, serif;
  font-weight: 500;
  font-size: 20px;
  letter-spacing: 0.05em;
  text-align: center;
  margin: 0;
  color: #F5F2EC;
}

.rune {
  color: #B87333;
  margin-right: 4px;
}

.action-btn {
  background: transparent;
  color: #B87333;
  border: 1px solid rgba(184,115,51,0.3);
  padding: 6px 14px;
  border-radius: 5px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
  white-space: nowrap;
  transition: background 150ms, border-color 150ms;
}
.action-btn:hover:not(:disabled) {
  background: rgba(184,115,51,0.08);
  border-color: rgba(184,115,51,0.5);
}
.action-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* ── Content ── */
.page-content {
  max-width: 720px;
  margin: 0 auto;
  padding: 32px 24px 80px;
}

/* ── States ── */
.state-empty {
  color: rgba(245,242,236,0.35);
  text-align: center;
  padding: 80px 0;
  font-style: italic;
  font-size: 14px;
}

/* ── Briefing list ── */
.brief-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.brief {
  position: relative;
  background: rgba(255,255,255,0.025);
  border: 1px solid rgba(255,255,255,0.07);
  border-radius: 8px;
  padding: 20px 22px;
  overflow: hidden;
}
.brief::before {
  content: '';
  position: absolute;
  top: 0; left: 0;
  width: 28px; height: 1px;
  background: #B87333;
  box-shadow: 0 0 6px rgba(184,115,51,0.35);
}

.brief__head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 14px;
}

.brief__date {
  font-family: 'Fraunces', Georgia, serif;
  font-size: 15px;
  color: #B87333;
}

.brief__when {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: rgba(245,242,236,0.35);
}

.brief__body {
  margin: 0;
  font-size: 14px;
  line-height: 1.7;
  white-space: pre-wrap;
  color: rgba(245,242,236,0.82);
}

.brief__foot {
  display: flex;
  justify-content: space-between;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid rgba(255,255,255,0.05);
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: rgba(245,242,236,0.28);
}

@media (max-width: 640px) {
  .page-header { padding: 12px 16px; }
  .page-content { padding: 24px 16px 60px; }
  .page-title { font-size: 17px; }
}

@media (prefers-reduced-motion: reduce) {
  * { transition-duration: 0ms !important; }
}
</style>
