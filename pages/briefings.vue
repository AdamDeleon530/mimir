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
  <div class="briefings">
    <header class="briefings__header">
      <NuxtLink to="/dashboard" class="briefings__back">← back to dashboard</NuxtLink>
      <h1 class="briefings__title"><span class="briefings__rune">ᚾ</span> Daily briefings</h1>
      <button @click="generateNow" :disabled="generating" class="briefings__gen">
        {{ generating ? 'consulting…' : 'generate now' }}
      </button>
    </header>

    <div v-if="pending && !data" class="briefings__loading">loading the log…</div>
    <div v-else-if="!data?.briefings?.length" class="briefings__empty">
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
          <span>queue {{ b.facts.queue.total }} · active {{ b.facts.queue.active }} · due today {{ b.facts.queue.due_today }}</span>
          <span v-if="b.tokens_used">{{ b.tokens_used.input + b.tokens_used.output }} tokens</span>
        </footer>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.briefings {
  max-width: 720px;
  margin: 0 auto;
  padding: 32px 24px 80px;
  color: #e7e5dc;
  font-family: 'Inter', system-ui, sans-serif;
}
.briefings__header {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 16px;
  margin-bottom: 32px;
}
.briefings__back {
  color: #c9a64a;
  text-decoration: none;
  font-size: 13px;
  opacity: 0.8;
}
.briefings__back:hover { opacity: 1; }
.briefings__title {
  font-family: 'Fraunces', serif;
  font-weight: 500;
  font-size: 24px;
  margin: 0;
  text-align: center;
  letter-spacing: 0.05em;
}
.briefings__rune { color: #c9a64a; margin-right: 6px; }
.briefings__gen {
  background: transparent;
  color: #c9a64a;
  border: 1px solid rgba(201, 166, 74, 0.35);
  padding: 6px 14px;
  border-radius: 4px;
  font-size: 12px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  font-family: inherit;
}
.briefings__gen:hover:not(:disabled) {
  background: rgba(201, 166, 74, 0.08);
}
.briefings__gen:disabled { opacity: 0.4; cursor: not-allowed; }

.briefings__loading,
.briefings__empty {
  color: rgba(231, 229, 220, 0.5);
  text-align: center;
  padding: 80px 0;
  font-style: italic;
}

.brief-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 24px; }
.brief {
  background: rgba(201, 166, 74, 0.03);
  border: 1px solid rgba(201, 166, 74, 0.15);
  border-radius: 6px;
  padding: 20px 22px;
}
.brief__head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 12px;
  font-size: 12px;
  color: rgba(231, 229, 220, 0.55);
}
.brief__date { font-family: 'Fraunces', serif; font-size: 15px; color: #d4b25c; }
.brief__body {
  margin: 0;
  font-size: 15px;
  line-height: 1.6;
  white-space: pre-wrap;
}
.brief__foot {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid rgba(201, 166, 74, 0.1);
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
  color: rgba(231, 229, 220, 0.4);
}
</style>
