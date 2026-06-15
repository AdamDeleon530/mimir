<script setup lang="ts">
definePageMeta({ middleware: 'auth' })

interface CellView {
  city: string
  niche_slug: string
  status: 'fresh' | 'maintenance' | 'saturated'
  last_scraped_at?: string
  scraped_count: number
  contacted_count: number
  replied_positive: number
  saturation_pct: number
  next_eligible_at?: string
  leads_in_db: number
  contacted_in_db: number
  avg_quality: number
  top_quality: number
}

interface MarketsResponse {
  cells: CellView[]
  totals: {
    total_cells: number
    fresh: number
    maintenance: number
    saturated: number
    scraped_all_time: number
    contacted_all_time: number
    replied_positive_all_time: number
  }
  grid: {
    cities: string[]
    niches: Array<{ slug: string; label: string }>
  }
}

const { data, pending, refresh } = await useFetch<MarketsResponse>('/api/markets')

const cellByKey = computed(() => {
  const m = new Map<string, CellView>()
  for (const c of data.value?.cells ?? []) m.set(`${c.city}|${c.niche_slug}`, c)
  return m
})

function getCell(city: string, niche: string): CellView | undefined {
  return cellByKey.value.get(`${city}|${niche}`)
}

function statusColor(c: CellView | undefined): string {
  if (!c) return 'transparent'
  const intensity = Math.max(8, Math.min(80, Math.round(c.avg_quality * 0.7)))
  if (c.status === 'saturated')   return `rgba(74,222,128,${intensity / 100})`
  if (c.status === 'maintenance') return `rgba(184,115,51,${intensity / 100})`
  return `rgba(96,140,210,${intensity / 100})`
}

function quickInfo(c: CellView | undefined): string {
  if (!c) return ''
  if (c.scraped_count === 0) return 'untouched'
  return `${c.leads_in_db} leads · q ${c.avg_quality}`
}

function timeAgo(iso: string | undefined): string {
  if (!iso) return 'never'
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86400)}d ago`
}

const hovered = ref<CellView | null>(null)
const totals = computed(() => data.value?.totals)
</script>

<template>
  <div class="page">
    <header class="page-header">
      <NuxtLink to="/dashboard" class="back-link">← dashboard</NuxtLink>
      <h1 class="page-title">
        <span class="rune" aria-hidden="true">ᚾ</span> Markets — Polk County
      </h1>
      <button
        @click="refresh()"
        :disabled="pending"
        class="action-btn"
        :aria-busy="pending"
      >
        {{ pending ? 'loading…' : 'refresh' }}
      </button>
    </header>

    <main class="page-content">

      <!-- KPI strip -->
      <section v-if="totals" class="kpi-strip" aria-label="Market totals">
        <div class="kpi">
          <p class="kpi__label">cells</p>
          <p class="kpi__value">{{ totals.total_cells }}</p>
        </div>
        <div class="kpi">
          <p class="kpi__label">fresh</p>
          <p class="kpi__value kpi__value--fresh">{{ totals.fresh }}</p>
        </div>
        <div class="kpi">
          <p class="kpi__label">maintenance</p>
          <p class="kpi__value kpi__value--copper">{{ totals.maintenance }}</p>
        </div>
        <div class="kpi">
          <p class="kpi__label">saturated</p>
          <p class="kpi__value kpi__value--green">{{ totals.saturated }}</p>
        </div>
        <div class="kpi">
          <p class="kpi__label">scraped all-time</p>
          <p class="kpi__value">{{ totals.scraped_all_time }}</p>
        </div>
        <div class="kpi">
          <p class="kpi__label">contacted</p>
          <p class="kpi__value">{{ totals.contacted_all_time }}</p>
        </div>
      </section>

      <div v-if="pending && !data" class="state-empty" aria-live="polite">loading the grid…</div>
      <div v-else-if="!data" class="state-empty">no data</div>

      <div v-else class="grid-wrap" aria-label="Market coverage grid">
        <div
          class="market-grid"
          :style="`grid-template-columns: 120px repeat(${data.grid.niches.length}, 1fr)`"
        >
          <!-- Corner -->
          <div class="grid-cell grid-corner" aria-hidden="true"></div>

          <!-- Column headers (niches) -->
          <div
            v-for="n in data.grid.niches"
            :key="n.slug"
            class="grid-cell grid-head grid-head--col"
            :title="n.label"
          >
            {{ n.label }}
          </div>

          <!-- Rows (cities × niches) -->
          <template v-for="city in data.grid.cities" :key="city">
            <div class="grid-cell grid-head grid-head--row">{{ city }}</div>
            <div
              v-for="n in data.grid.niches"
              :key="`${city}-${n.slug}`"
              class="grid-cell grid-data"
              :style="{ background: statusColor(getCell(city, n.slug)) }"
              :aria-label="`${city} ${n.label}: ${quickInfo(getCell(city, n.slug)) || 'no data'}`"
              @mouseenter="hovered = getCell(city, n.slug) ?? null"
              @mouseleave="hovered = null"
            >
              <span class="grid-quick">{{ quickInfo(getCell(city, n.slug)) }}</span>
              <span v-if="getCell(city, n.slug)?.replied_positive" class="grid-star">
                ★ {{ getCell(city, n.slug)?.replied_positive }}
              </span>
            </div>
          </template>
        </div>
      </div>

      <!-- Legend -->
      <div class="legend" aria-label="Status legend">
        <span class="legend-item legend-item--fresh">fresh</span>
        <span class="legend-item legend-item--maintenance">maintenance</span>
        <span class="legend-item legend-item--saturated">saturated</span>
        <span class="legend-note">cell intensity = avg quality score</span>
      </div>

    </main>

    <!-- Hover detail panel -->
    <Transition name="detail-fade">
      <aside
        v-if="hovered"
        class="hover-detail"
        aria-live="polite"
        aria-label="Cell details"
      >
        <h2 class="detail-title">{{ hovered.city }} · {{ hovered.niche_slug }}</h2>
        <dl class="detail-list">
          <dt>status</dt>       <dd>{{ hovered.status }}</dd>
          <dt>last scraped</dt> <dd>{{ timeAgo(hovered.last_scraped_at) }}</dd>
          <dt>next eligible</dt><dd>{{ hovered.next_eligible_at ? timeAgo(hovered.next_eligible_at).replace(' ago', '') + ' remaining' : 'ready now' }}</dd>
          <dt>scraped total</dt><dd>{{ hovered.scraped_count }}</dd>
          <dt>contacted</dt>    <dd>{{ hovered.contacted_count }} ({{ hovered.saturation_pct }}%)</dd>
          <dt>positive replies</dt><dd>{{ hovered.replied_positive }}</dd>
          <dt>leads in DB</dt>  <dd>{{ hovered.leads_in_db }}</dd>
          <dt>avg quality</dt>  <dd>{{ hovered.avg_quality }}</dd>
          <dt>top quality</dt>  <dd>{{ hovered.top_quality }}</dd>
        </dl>
      </aside>
    </Transition>
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
}

.rune { color: #B87333; margin-right: 4px; }

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
  max-width: 1200px;
  margin: 0 auto;
  padding: 28px 24px 100px;
}

.state-empty {
  color: rgba(245,242,236,0.35);
  text-align: center;
  padding: 80px 0;
  font-style: italic;
  font-size: 14px;
}

/* ── KPI strip ── */
.kpi-strip {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 10px;
  margin-bottom: 24px;
}

.kpi {
  position: relative;
  background: rgba(255,255,255,0.025);
  border: 1px solid rgba(255,255,255,0.07);
  border-radius: 8px;
  padding: 12px 14px;
  overflow: hidden;
}
.kpi::before {
  content: '';
  position: absolute;
  top: 0; left: 0;
  width: 20px; height: 1px;
  background: #B87333;
  box-shadow: 0 0 5px rgba(184,115,51,0.3);
}

.kpi__label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: rgba(245,242,236,0.3);
  margin: 0 0 5px;
}

.kpi__value {
  font-family: 'Fraunces', Georgia, serif;
  font-size: 24px;
  font-weight: 500;
  color: rgba(245,242,236,0.88);
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.kpi__value--copper  { color: #B87333; }
.kpi__value--green   { color: rgba(74,222,128,0.8); }
.kpi__value--fresh   { color: rgba(96,140,210,0.9); }

/* ── Grid ── */
.grid-wrap {
  overflow-x: auto;
  border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.07);
}

.market-grid {
  display: grid;
  gap: 1px;
  background: rgba(255,255,255,0.05);
  min-width: 700px;
}

.grid-cell {
  background: rgba(11,21,37,0.97);
  padding: 8px 10px;
  font-size: 11px;
  min-height: 52px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.grid-corner { background: rgba(11,21,37,0.97); }

.grid-head {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: rgba(184,115,51,0.8);
  font-weight: 500;
}
.grid-head--col { text-align: center; line-height: 1.3; background: rgba(11,21,37,0.97); }
.grid-head--row { text-align: right; padding-right: 12px; background: rgba(11,21,37,0.97); }

.grid-data {
  cursor: pointer;
  transition: filter 120ms ease;
}
.grid-data:hover { filter: brightness(1.5) saturate(1.2); }

.grid-quick {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.02em;
  color: rgba(245,242,236,0.7);
  mix-blend-mode: plus-lighter;
}
.grid-star {
  font-size: 10px;
  color: rgba(245,242,236,0.8);
  margin-top: 2px;
  mix-blend-mode: plus-lighter;
}

/* ── Legend ── */
.legend {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 14px;
  flex-wrap: wrap;
}
.legend-item {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid;
}
.legend-item--fresh       { color: rgba(96,140,210,0.9);  border-color: rgba(96,140,210,0.25);  background: rgba(96,140,210,0.08); }
.legend-item--maintenance { color: rgba(184,115,51,0.9);  border-color: rgba(184,115,51,0.25);  background: rgba(184,115,51,0.08); }
.legend-item--saturated   { color: rgba(74,222,128,0.85); border-color: rgba(74,222,128,0.25);  background: rgba(74,222,128,0.08); }
.legend-note {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  color: rgba(245,242,236,0.2);
  letter-spacing: 0.04em;
  margin-left: auto;
}

/* ── Hover detail panel ── */
.hover-detail {
  position: fixed;
  bottom: 24px;
  right: 24px;
  width: 260px;
  background: #0b1525;
  border: 1px solid rgba(184,115,51,0.25);
  border-radius: 8px;
  padding: 18px 20px;
  backdrop-filter: blur(12px);
  pointer-events: none;
  z-index: 50;
}

.detail-title {
  font-family: 'Fraunces', Georgia, serif;
  font-weight: 500;
  font-size: 15px;
  margin: 0 0 12px;
  color: #B87333;
  letter-spacing: 0.03em;
}

.detail-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px 12px;
  margin: 0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
}
.detail-list dt { color: rgba(245,242,236,0.38); margin: 0; }
.detail-list dd { color: rgba(245,242,236,0.82); margin: 0; text-align: right; font-variant-numeric: tabular-nums; }

/* ── Hover detail transition ── */
.detail-fade-enter-active { transition: opacity 150ms ease, transform 150ms ease; }
.detail-fade-leave-active { transition: opacity 120ms ease, transform 120ms ease; }
.detail-fade-enter-from   { opacity: 0; transform: translateY(4px); }
.detail-fade-leave-to     { opacity: 0; transform: translateY(4px); }

/* ── Responsive ── */
@media (max-width: 1024px) {
  .kpi-strip { grid-template-columns: repeat(3, 1fr); }
}
@media (max-width: 640px) {
  .page-header { padding: 12px 16px; }
  .page-content { padding: 20px 16px 80px; }
  .kpi-strip { grid-template-columns: repeat(2, 1fr); }
  .hover-detail { bottom: 16px; right: 16px; left: 16px; width: auto; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0ms !important; }
}
</style>
