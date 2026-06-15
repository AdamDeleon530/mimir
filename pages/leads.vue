<script setup lang="ts">
definePageMeta({ middleware: 'auth' })

interface IndexEntry {
  domain: string
  business_name: string
  city: string
  niche: string
  status: string
  dnc: boolean
  quality_total?: number
  last_contacted_at?: string
  last_updated_at: string
}

interface ListResponse {
  count: number
  total: number
  leads: IndexEntry[]
}

interface FullLeadResponse {
  lead: {
    domain: string
    business_name: string
    city: string
    state: string
    niche: string
    phone: string
    website: string
    emails: Array<{ value: string; source: string; verification: string }>
    decision_maker?: { first_name: string; last_name: string; title?: string; linkedin_url?: string; confidence: number }
    gbp_url: string
    gbp_score: number
    rating: number
    reviews_count: number
    photo_count: number
    license?: { number: string; class: string; status: string; years_tenure?: number }
    signals?: { hiring?: { count: number }; permits_30d?: { count: number } }
    quality?: { total: number; gbp: number; license: number; decision_maker: number; intent: number; reachability: number }
    status: string
    dnc: boolean
    sources: Array<{ name: string }>
    first_seen_at: string
    last_updated_at: string
    last_contacted_at?: string
  }
  interactions: Array<{ at: string; type: string; source?: string; details?: Record<string, unknown> }>
}

const filters = reactive({
  status: '',
  city: '',
  niche: '',
  min_quality: 0,
  dnc: '',
  q: '',
})

const sortColumn = ref<'quality_total' | 'business_name' | 'city' | 'last_updated_at'>('quality_total')
const sortDir = ref<'asc' | 'desc'>('desc')

const queryString = computed(() => {
  const p = new URLSearchParams()
  if (filters.status) p.set('status', filters.status)
  if (filters.city) p.set('city', filters.city)
  if (filters.niche) p.set('niche', filters.niche)
  if (filters.min_quality > 0) p.set('min_quality', String(filters.min_quality))
  if (filters.dnc) p.set('dnc', filters.dnc)
  if (filters.q) p.set('q', filters.q)
  p.set('limit', '200')
  return p.toString()
})

const { data, pending, refresh } = await useFetch<ListResponse>(() => `/api/leads?${queryString.value}`, {
  watch: [queryString],
})

const sortedLeads = computed(() => {
  if (!data.value?.leads) return []
  const arr = [...data.value.leads]
  arr.sort((a, b) => {
    const col = sortColumn.value
    const av = a[col] ?? (typeof a[col] === 'number' ? 0 : '')
    const bv = b[col] ?? (typeof b[col] === 'number' ? 0 : '')
    let cmp = 0
    if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv
    else cmp = String(av).localeCompare(String(bv))
    return sortDir.value === 'asc' ? cmp : -cmp
  })
  return arr
})

function setSort(col: 'quality_total' | 'business_name' | 'city' | 'last_updated_at') {
  if (sortColumn.value === col) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else { sortColumn.value = col; sortDir.value = 'desc' }
}

const selected = ref<string | null>(null)
const detail = ref<FullLeadResponse | null>(null)
const detailPending = ref(false)

async function openDetail(domain: string) {
  if (selected.value === domain) {
    selected.value = null
    detail.value = null
    return
  }
  selected.value = domain
  detailPending.value = true
  try {
    detail.value = await $fetch<FullLeadResponse>(`/api/leads/${encodeURIComponent(domain)}`)
  } finally {
    detailPending.value = false
  }
}

function clearFilters() {
  filters.status = ''
  filters.city = ''
  filters.niche = ''
  filters.min_quality = 0
  filters.dnc = ''
  filters.q = ''
}

function timeAgo(iso: string | undefined): string {
  if (!iso) return '—'
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`
  return `${Math.floor(sec / 86400)}d`
}

// Renders interaction details as "key: value · key: value" instead of raw JSON
function formatDetails(d: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(d)) {
    if (v == null || v === '' || v === false) continue
    const label = k.replace(/_/g, ' ')
    let val: string
    if (Array.isArray(v)) {
      val = v.join(', ')
    } else if (typeof v === 'object') {
      val = Object.entries(v as Record<string, unknown>)
        .filter(([, vv]) => vv != null)
        .map(([kk, vv]) => `${kk.replace(/_/g, ' ')}: ${vv}`)
        .join(', ')
    } else {
      val = String(v)
    }
    if (val.length > 60) val = val.slice(0, 60) + '…'
    parts.push(`${label}: ${val}`)
  }
  return parts.join(' · ')
}

function statusClass(s: string): string {
  if (s === 'client') return 'pill--client'
  if (s === 'contacted' || s === 'replied_positive') return 'pill--active'
  if (s === 'queued' || s === 'enriched') return 'pill--warm'
  if (s === 'do_not_contact' || s === 'bounced' || s === 'unsubscribed') return 'pill--dead'
  return 'pill--neutral'
}

const CITIES = ['Lakeland', 'Winter Haven', 'Bartow', 'Auburndale', 'Haines City', 'Davenport', 'Lake Wales']
const NICHES = ['general contractor', 'kitchen remodeler', 'roofer', 'hvac', 'electrician', 'plumber', 'landscaper', 'pool builder']
const STATUSES = ['new', 'enriched', 'queued', 'contacted', 'replied_positive', 'replied_question', 'replied_objection', 'unsubscribed', 'bounced', 'client', 'do_not_contact']
</script>

<template>
  <div class="page">
    <header class="page-header">
      <NuxtLink to="/dashboard" class="back-link">← dashboard</NuxtLink>
      <h1 class="page-title">
        <span class="rune" aria-hidden="true">ᚾ</span> Leads
      </h1>
      <div class="header-right">
        <span class="font-mono text-[11px]" style="color: rgba(245,242,236,0.4);" aria-live="polite">
          {{ data?.count ?? 0 }} of {{ data?.total ?? 0 }}
        </span>
        <button
          @click="refresh()"
          :disabled="pending"
          class="icon-btn"
          title="Refresh"
          aria-label="Refresh leads"
        >↻</button>
      </div>
    </header>

    <!-- Filters -->
    <div class="filters-bar">
      <input
        v-model="filters.q"
        type="search"
        placeholder="search name or domain…"
        class="filter filter--text"
        aria-label="Search leads"
      />
      <select v-model="filters.status" class="filter" aria-label="Filter by status">
        <option value="">all statuses</option>
        <option v-for="s in STATUSES" :key="s" :value="s">{{ s }}</option>
      </select>
      <select v-model="filters.city" class="filter" aria-label="Filter by city">
        <option value="">all cities</option>
        <option v-for="c in CITIES" :key="c" :value="c">{{ c }}</option>
      </select>
      <select v-model="filters.niche" class="filter" aria-label="Filter by niche">
        <option value="">all niches</option>
        <option v-for="n in NICHES" :key="n" :value="n">{{ n }}</option>
      </select>
      <label class="filter filter--slider">
        <span>quality ≥ {{ filters.min_quality }}</span>
        <input
          type="range"
          v-model.number="filters.min_quality"
          min="0" max="100" step="5"
          aria-label="Minimum quality score"
        />
      </label>
      <select v-model="filters.dnc" class="filter" aria-label="Filter by DNC status">
        <option value="">DNC: any</option>
        <option value="false">DNC: no</option>
        <option value="true">DNC: yes</option>
      </select>
      <button @click="clearFilters()" class="filter filter--clear" aria-label="Clear all filters">
        clear
      </button>
    </div>

    <!-- Table area -->
    <main class="table-area">
      <div v-if="pending && !data" class="state-empty" aria-live="polite">loading…</div>
      <div v-else-if="!sortedLeads.length" class="state-empty">
        no leads match these filters.
        <code>pnpm seed-leads</code> if the DB is empty.
      </div>

      <div v-else class="table-wrap">
        <table class="table" aria-label="Leads database">
          <thead>
            <tr>
              <th
                @click="setSort('business_name')"
                class="th th--sortable"
                :aria-sort="sortColumn === 'business_name' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'"
              >
                business
                <span v-if="sortColumn === 'business_name'" class="sort-arrow" aria-hidden="true">{{ sortDir === 'asc' ? '↑' : '↓' }}</span>
              </th>
              <th
                @click="setSort('city')"
                class="th th--sortable"
                :aria-sort="sortColumn === 'city' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'"
              >
                city
                <span v-if="sortColumn === 'city'" class="sort-arrow" aria-hidden="true">{{ sortDir === 'asc' ? '↑' : '↓' }}</span>
              </th>
              <th class="th">niche</th>
              <th
                @click="setSort('quality_total')"
                class="th th--sortable th--right"
                :aria-sort="sortColumn === 'quality_total' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'"
              >
                quality
                <span v-if="sortColumn === 'quality_total'" class="sort-arrow" aria-hidden="true">{{ sortDir === 'asc' ? '↑' : '↓' }}</span>
              </th>
              <th class="th">status</th>
              <th
                @click="setSort('last_updated_at')"
                class="th th--sortable th--right"
                :aria-sort="sortColumn === 'last_updated_at' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'"
              >
                updated
                <span v-if="sortColumn === 'last_updated_at'" class="sort-arrow" aria-hidden="true">{{ sortDir === 'asc' ? '↑' : '↓' }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <template v-for="lead in sortedLeads" :key="lead.domain">
              <!-- Lead row -->
              <tr
                @click="openDetail(lead.domain)"
                :class="['row', selected === lead.domain ? 'row--open' : '']"
                :aria-expanded="selected === lead.domain"
                :aria-label="`${lead.business_name || lead.domain} — click to ${selected === lead.domain ? 'close' : 'view'} details`"
                tabindex="0"
                @keydown.enter="openDetail(lead.domain)"
              >
                <td class="cell">
                  <p class="cell__name">{{ lead.business_name || lead.domain }}</p>
                  <p class="cell__domain">{{ lead.domain }}</p>
                </td>
                <td class="cell">{{ lead.city || '—' }}</td>
                <td class="cell">{{ lead.niche || '—' }}</td>
                <td class="cell cell--right">
                  <span :class="['quality', `quality--${qualityBucket(lead.quality_total)}`]">
                    {{ lead.quality_total ?? '—' }}
                  </span>
                </td>
                <td class="cell">
                  <span :class="['pill', statusClass(lead.status)]">{{ lead.status }}</span>
                  <span v-if="lead.dnc" class="pill pill--dnc">DNC</span>
                </td>
                <td class="cell cell--right cell--dim">{{ timeAgo(lead.last_updated_at) }}</td>
              </tr>

              <!-- Detail drawer row -->
              <tr v-if="selected === lead.domain" class="detail-row">
                <td colspan="6" class="detail-cell">
                  <div v-if="detailPending" class="detail-loading">loading record…</div>
                  <div v-else-if="detail" class="detail-grid">

                    <!-- Identity -->
                    <section class="d-card">
                      <div class="d-card__stripe" aria-hidden="true"></div>
                      <h3 class="d-card__title">Identity</h3>
                      <dl class="d-dl">
                        <dt>phone</dt>
                        <dd>{{ detail.lead.phone || '—' }}</dd>
                        <dt>website</dt>
                        <dd>
                          <a v-if="detail.lead.website" :href="detail.lead.website" target="_blank" rel="noopener" class="detail-link">
                            {{ detail.lead.website.replace(/^https?:\/\//, '') }}
                          </a>
                          <span v-else>—</span>
                        </dd>
                        <dt>GBP</dt>
                        <dd>
                          <a v-if="detail.lead.gbp_url" :href="detail.lead.gbp_url" target="_blank" rel="noopener" class="detail-link">view profile ↗</a>
                          <span v-else>—</span>
                        </dd>
                        <dt>sources</dt>
                        <dd>{{ detail.lead.sources.map(s => s.name).join(', ') || '—' }}</dd>
                        <dt>first seen</dt>
                        <dd>{{ timeAgo(detail.lead.first_seen_at) }} ago</dd>
                      </dl>
                    </section>

                    <!-- Contact -->
                    <section class="d-card">
                      <div class="d-card__stripe" aria-hidden="true"></div>
                      <h3 class="d-card__title">Contact</h3>
                      <dl class="d-dl">
                        <template v-if="detail.lead.emails.length">
                          <template v-for="(e, i) in detail.lead.emails" :key="i">
                            <dt>email {{ i + 1 }}</dt>
                            <dd>
                              {{ e.value }}
                              <span class="d-tag" :class="e.verification === 'ok' ? 'd-tag--ok' : 'd-tag--warn'">
                                {{ e.verification }}
                              </span>
                            </dd>
                          </template>
                        </template>
                        <template v-else>
                          <dt>email</dt><dd class="detail-dim">none found</dd>
                        </template>
                        <template v-if="detail.lead.decision_maker">
                          <dt>owner</dt>
                          <dd>
                            {{ detail.lead.decision_maker.first_name }} {{ detail.lead.decision_maker.last_name }}
                            <span class="detail-dim" v-if="detail.lead.decision_maker.title"> · {{ detail.lead.decision_maker.title }}</span>
                          </dd>
                          <dt>confidence</dt>
                          <dd>{{ Math.round(detail.lead.decision_maker.confidence * 100) }}%</dd>
                        </template>
                      </dl>
                    </section>

                    <!-- GBP -->
                    <section class="d-card">
                      <div class="d-card__stripe" aria-hidden="true"></div>
                      <h3 class="d-card__title">GBP</h3>
                      <dl class="d-dl">
                        <dt>score</dt>
                        <dd>
                          <span :class="['quality', `quality--${qualityBucket(detail.lead.gbp_score * 10)}`]">
                            {{ detail.lead.gbp_score }}/10
                          </span>
                        </dd>
                        <dt>rating</dt>
                        <dd>{{ detail.lead.rating?.toFixed(1) ?? '—' }} <span class="detail-dim">★</span></dd>
                        <dt>reviews</dt>
                        <dd>{{ detail.lead.reviews_count }}</dd>
                        <dt>photos</dt>
                        <dd>{{ detail.lead.photo_count }}</dd>
                      </dl>
                    </section>

                    <!-- License -->
                    <section class="d-card">
                      <div class="d-card__stripe" aria-hidden="true"></div>
                      <h3 class="d-card__title">License</h3>
                      <dl v-if="detail.lead.license" class="d-dl">
                        <dt>number</dt>
                        <dd class="font-mono">{{ detail.lead.license.number }}</dd>
                        <dt>class</dt>
                        <dd>{{ detail.lead.license.class }}</dd>
                        <dt>status</dt>
                        <dd>
                          <span :class="['d-tag', detail.lead.license.status === 'active' ? 'd-tag--ok' : 'd-tag--warn']">
                            {{ detail.lead.license.status }}
                          </span>
                        </dd>
                        <template v-if="detail.lead.license.years_tenure">
                          <dt>tenure</dt>
                          <dd>{{ detail.lead.license.years_tenure }} yrs</dd>
                        </template>
                      </dl>
                      <p v-else class="detail-dim text-[12px]">no license attached</p>
                    </section>

                    <!-- Quality breakdown -->
                    <section v-if="detail.lead.quality" class="d-card">
                      <div class="d-card__stripe" aria-hidden="true"></div>
                      <h3 class="d-card__title">
                        Quality
                        <span :class="['quality quality--inline', `quality--${qualityBucket(detail.lead.quality.total)}`]">
                          {{ detail.lead.quality.total }}/100
                        </span>
                      </h3>
                      <div class="quality-bars">
                        <div class="qbar">
                          <span class="qbar__label">GBP</span>
                          <div class="qbar__track">
                            <div class="qbar__fill" :style="`width: ${(detail.lead.quality.gbp / 25) * 100}%`"></div>
                          </div>
                          <span class="qbar__val">{{ detail.lead.quality.gbp }}/25</span>
                        </div>
                        <div class="qbar">
                          <span class="qbar__label">license</span>
                          <div class="qbar__track">
                            <div class="qbar__fill" :style="`width: ${(detail.lead.quality.license / 20) * 100}%`"></div>
                          </div>
                          <span class="qbar__val">{{ detail.lead.quality.license }}/20</span>
                        </div>
                        <div class="qbar">
                          <span class="qbar__label">owner</span>
                          <div class="qbar__track">
                            <div class="qbar__fill" :style="`width: ${(detail.lead.quality.decision_maker / 20) * 100}%`"></div>
                          </div>
                          <span class="qbar__val">{{ detail.lead.quality.decision_maker }}/20</span>
                        </div>
                        <div class="qbar">
                          <span class="qbar__label">intent</span>
                          <div class="qbar__track">
                            <div class="qbar__fill" :style="`width: ${(detail.lead.quality.intent / 20) * 100}%`"></div>
                          </div>
                          <span class="qbar__val">{{ detail.lead.quality.intent }}/20</span>
                        </div>
                        <div class="qbar">
                          <span class="qbar__label">reach</span>
                          <div class="qbar__track">
                            <div class="qbar__fill" :style="`width: ${(detail.lead.quality.reachability / 15) * 100}%`"></div>
                          </div>
                          <span class="qbar__val">{{ detail.lead.quality.reachability }}/15</span>
                        </div>
                      </div>
                    </section>

                    <!-- Signals -->
                    <section class="d-card">
                      <div class="d-card__stripe" aria-hidden="true"></div>
                      <h3 class="d-card__title">Signals</h3>
                      <dl v-if="detail.lead.signals && (detail.lead.signals.hiring || detail.lead.signals.permits_30d)" class="d-dl">
                        <template v-if="detail.lead.signals.hiring">
                          <dt>hiring</dt><dd>{{ detail.lead.signals.hiring.count }} open jobs</dd>
                        </template>
                        <template v-if="detail.lead.signals.permits_30d">
                          <dt>permits 30d</dt><dd>{{ detail.lead.signals.permits_30d.count }}</dd>
                        </template>
                      </dl>
                      <p v-else class="detail-dim text-[12px]">no signals detected</p>
                    </section>

                    <!-- Activity log (full width) -->
                    <section class="d-card d-card--full">
                      <div class="d-card__stripe" aria-hidden="true"></div>
                      <h3 class="d-card__title">
                        Activity
                        <span class="d-card__count">{{ detail.interactions.length }}</span>
                      </h3>
                      <ul v-if="detail.interactions.length" class="activity-list">
                        <li v-for="(ev, i) in detail.interactions" :key="i" class="activity-item">
                          <time class="activity-age" :title="ev.at">{{ timeAgo(ev.at) }}</time>
                          <span class="activity-type">{{ ev.type.replace(/_/g, ' ') }}</span>
                          <span v-if="ev.source" class="activity-source">{{ ev.source }}</span>
                          <span v-if="ev.details" class="activity-detail">{{ formatDetails(ev.details) }}</span>
                        </li>
                      </ul>
                      <p v-else class="detail-dim text-[12px]">no recorded activity yet</p>
                    </section>

                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </main>
  </div>
</template>

<script lang="ts">
function qualityBucket(q: number | undefined): string {
  if (q === undefined) return 'none'
  if (q >= 80) return 'top'
  if (q >= 60) return 'good'
  if (q >= 40) return 'mid'
  return 'low'
}
</script>

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
  padding: 14px 24px;
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

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: flex-end;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 5px;
  background: rgba(255,255,255,0.02);
  color: rgba(245,242,236,0.35);
  font-size: 15px;
  cursor: pointer;
  transition: color 150ms, border-color 150ms;
}
.icon-btn:hover { color: #B87333; border-color: rgba(184,115,51,0.25); }
.icon-btn:disabled { opacity: 0.35; cursor: not-allowed; }

/* ── Filters ── */
.filters-bar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding: 12px 24px;
  border-bottom: 1px solid rgba(255,255,255,0.05);
  background: rgba(255,255,255,0.01);
}

.filter {
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.09);
  color: #F5F2EC;
  padding: 6px 10px;
  border-radius: 5px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  outline: none;
  transition: border-color 150ms;
}
.filter:focus { border-color: rgba(184,115,51,0.4); }
.filter option { background: #0b1525; }

.filter--text { flex: 1; min-width: 180px; }
.filter--slider {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: rgba(245,242,236,0.5);
  border: none;
  background: none;
  padding: 0 4px;
}
.filter--slider input[type="range"] {
  width: 80px;
  accent-color: #B87333;
  background: none;
  border: none;
  padding: 0;
}
.filter--clear {
  background: none;
  color: rgba(184,115,51,0.7);
  border-color: rgba(184,115,51,0.2);
  cursor: pointer;
}
.filter--clear:hover { background: rgba(184,115,51,0.07); }

/* ── Table area ── */
.table-area {
  padding: 0 0 80px;
}

.state-empty {
  color: rgba(245,242,236,0.35);
  text-align: center;
  padding: 60px 24px;
  font-style: italic;
  font-size: 14px;
}
.state-empty code {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  color: #B87333;
  background: rgba(184,115,51,0.08);
  padding: 2px 7px;
  border-radius: 3px;
}

.table-wrap { overflow-x: auto; }

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

/* ── Column headers ── */
.th {
  text-align: left;
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgba(245,242,236,0.35);
  padding: 8px 12px;
  border-bottom: 1px solid rgba(255,255,255,0.07);
  white-space: nowrap;
  font-weight: 500;
  user-select: none;
}
.th--right { text-align: right; }
.th--sortable { cursor: pointer; }
.th--sortable:hover { color: #B87333; }

.sort-arrow {
  color: #B87333;
  margin-left: 4px;
}

/* ── Table rows ── */
.row {
  cursor: pointer;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  transition: background 100ms;
}
.row:hover { background: rgba(255,255,255,0.025); }
.row--open { background: rgba(184,115,51,0.06); }
.row:focus { outline: 1px solid rgba(184,115,51,0.3); outline-offset: -1px; }

.cell { padding: 10px 12px; vertical-align: middle; }
.cell--right { text-align: right; }
.cell--dim {
  color: rgba(245,242,236,0.35);
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.cell__name { font-weight: 500; font-size: 13px; }
.cell__domain {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: rgba(245,242,236,0.3);
  margin-top: 1px;
}

/* ── Quality badge ── */
.quality {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 3px;
  font-variant-numeric: tabular-nums;
}
.quality--top  { color: rgba(74,222,128,0.9);  background: rgba(74,222,128,0.1); }
.quality--good { color: #B87333;               background: rgba(184,115,51,0.1); }
.quality--mid  { color: rgba(184,115,51,0.65); background: rgba(184,115,51,0.05); }
.quality--low  { color: rgba(245,242,236,0.3); }
.quality--none { color: rgba(245,242,236,0.2); }

/* ── Status pills ── */
.pill {
  display: inline-block;
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.06em;
  padding: 2px 8px;
  border-radius: 999px;
  margin-right: 4px;
  white-space: nowrap;
}
.pill--active  { background: rgba(74,222,128,0.1);  color: rgba(74,222,128,0.85); }
.pill--warm    { background: rgba(184,115,51,0.12); color: rgba(184,115,51,0.9); }
.pill--client  { background: rgba(184,115,51,0.18); color: #B87333; font-weight: 600; }
.pill--dead    { background: rgba(239,68,68,0.08);  color: rgba(239,68,68,0.7); }
.pill--dnc     { background: rgba(239,68,68,0.12);  color: rgba(239,68,68,0.8); }
.pill--neutral { background: rgba(255,255,255,0.05); color: rgba(245,242,236,0.45); }

/* ── Detail row ── */
.detail-row td { padding: 0; }

.detail-cell {
  padding: 20px 24px;
  background: rgba(9,17,31,0.8);
  border-top: 1px solid rgba(184,115,51,0.15);
  border-bottom: 1px solid rgba(184,115,51,0.15);
}

.detail-loading {
  color: rgba(245,242,236,0.4);
  font-style: italic;
  font-size: 13px;
  padding: 12px 0;
}

/* 3-column grid; last section (activity) spans all */
.detail-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

/* ── Detail card ── */
.d-card {
  position: relative;
  background: rgba(255,255,255,0.025);
  border: 1px solid rgba(255,255,255,0.07);
  border-radius: 7px;
  padding: 14px 16px;
  overflow: hidden;
}
.d-card--full { grid-column: 1 / -1; }

.d-card__stripe {
  position: absolute;
  top: 0; left: 0;
  width: 22px; height: 1px;
  background: #B87333;
  box-shadow: 0 0 5px rgba(184,115,51,0.3);
}

.d-card__title {
  font-family: 'Fraunces', Georgia, serif;
  font-size: 12px;
  font-weight: 500;
  margin: 0 0 12px;
  color: #B87333;
  letter-spacing: 0.04em;
  display: flex;
  align-items: center;
  gap: 8px;
}

.d-card__count {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: rgba(245,242,236,0.3);
  background: rgba(255,255,255,0.05);
  padding: 1px 7px;
  border-radius: 999px;
  font-weight: 400;
}

/* ── Definition list ── */
.d-dl {
  display: grid;
  grid-template-columns: 76px 1fr;
  gap: 7px 12px;
  margin: 0;
  align-items: baseline;
}
.d-dl dt {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: rgba(245,242,236,0.32);
  white-space: nowrap;
  padding-top: 1px;
}
.d-dl dd {
  margin: 0;
  font-size: 12px;
  color: rgba(245,242,236,0.82);
  word-break: break-word;
  line-height: 1.4;
}

/* ── Inline tags ── */
.d-tag {
  display: inline-block;
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.06em;
  padding: 1px 6px;
  border-radius: 999px;
  margin-left: 5px;
  vertical-align: middle;
}
.d-tag--ok   { background: rgba(74,222,128,0.1);  color: rgba(74,222,128,0.85); }
.d-tag--warn { background: rgba(239,68,68,0.1);   color: rgba(239,68,68,0.75); }

/* ── Quality bars ── */
.quality-bars {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.qbar {
  display: grid;
  grid-template-columns: 50px 1fr 36px;
  align-items: center;
  gap: 8px;
}
.qbar__label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(245,242,236,0.32);
  text-align: right;
}
.qbar__track {
  height: 4px;
  background: rgba(255,255,255,0.07);
  border-radius: 2px;
  overflow: hidden;
}
.qbar__fill {
  height: 100%;
  background: #B87333;
  border-radius: 2px;
  transition: width 400ms ease;
}
.qbar__val {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: rgba(245,242,236,0.5);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* ── Quality badge (inline in title) ── */
.quality--inline {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  font-weight: 500;
  padding: 1px 8px;
  border-radius: 3px;
  letter-spacing: 0;
}

/* ── Activity log ── */
.activity-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.activity-item {
  display: grid;
  grid-template-columns: 36px 140px auto 1fr;
  align-items: baseline;
  gap: 0 12px;
  padding: 7px 0;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  font-size: 11px;
}
.activity-item:last-child { border-bottom: none; padding-bottom: 0; }

.activity-age {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: rgba(245,242,236,0.28);
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.activity-type {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: #B87333;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.activity-source {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: rgba(245,242,236,0.32);
  white-space: nowrap;
}

.activity-detail {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: rgba(245,242,236,0.48);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-link { color: #B87333; text-decoration: none; font-size: 12px; }
.detail-link:hover { text-decoration: underline; }
.detail-dim { color: rgba(245,242,236,0.32); }

/* ── Responsive ── */
@media (max-width: 1024px) {
  .detail-grid { grid-template-columns: repeat(2, 1fr); }
  .d-card--full { grid-column: 1 / -1; }
  .activity-item { grid-template-columns: 36px 1fr; grid-template-rows: auto auto; }
  .activity-source { grid-column: 2; }
  .activity-detail { grid-column: 2; white-space: normal; }
}
@media (max-width: 768px) {
  .page-header { padding: 12px 16px; }
  .filters-bar { padding: 10px 16px; }
  .detail-grid { grid-template-columns: 1fr; }
  .d-card--full { grid-column: 1; }
  .detail-cell { padding: 14px 16px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0ms !important; }
}
</style>
