/**
 * Master lead database — KV-backed, keyed by normalized domain.
 *
 * One record per business (not per email) — a contractor with three inbox
 * addresses still has one record. This is the source of truth for:
 *   - what we know about every contractor we've ever scraped
 *   - every interaction with that contractor (sent emails, replies, notes)
 *   - suppression status (DNC) and last-contacted recency
 *   - signals attached over time (license, hiring, permits, GBP changes)
 *
 * Index: a single JSON map at `mimir:leads:index` of { domain → summary } so
 * filter queries (listLeads by city / niche / status) are one KV read +
 * in-memory filter. Fine to ~50K records; we cross that bridge later.
 *
 * Per-domain detail: `mimir:leads:<domainHash>` (full record).
 * Per-domain interactions: `mimir:leads:<domainHash>:events` (RPUSH list).
 * Suppression list: `mimir:leads:dnc` (Array<string> of domains).
 */
import { kv } from './kv'
import { hashKey } from './kv-cache'

// =====================================================================
// TYPES
// =====================================================================

export type LeadStatus =
  | 'new'             // discovered, not yet enriched
  | 'enriched'        // contact info attached
  | 'queued'          // in the sequence queue
  | 'contacted'       // at least one email sent
  | 'replied_positive'
  | 'replied_question'
  | 'replied_objection'
  | 'replied_ooo'
  | 'unsubscribed'
  | 'bounced'
  | 'client'          // signed
  | 'rejected'        // we said no
  | 'do_not_contact'  // explicit DNC, never re-engage

export type LicenseClass = string  // 'CGC', 'CBC', 'CRC', 'CCC', 'CMC', 'CFC', 'CAC', etc.
export type LicenseStatus = 'active' | 'expired' | 'suspended' | 'revoked' | 'voluntarily_relinquished' | 'unknown' | 'not_found'

export interface LeadEmail {
  value: string
  source: 'hunter' | 'website_scrape' | 'manual' | 'imap_reply'
  verification: 'ok' | 'risky' | 'bad' | 'unknown'
  last_verified_at?: string
}

export interface DecisionMaker {
  first_name: string
  last_name: string
  title?: string
  linkedin_url?: string
  source: 'hunter' | 'linkedin' | 'manual'
  confidence: number  // 0-1
}

export interface FloridaLicense {
  number: string
  class: LicenseClass
  status: LicenseStatus
  issue_date?: string
  expiration_date?: string
  years_tenure?: number
  discipline_count: number
  matched_business_name?: string  // name as it appears in DBPR
  matched_via: 'local_snapshot' | 'remote_search' | 'manual'
  checked_at: string
}

export interface LeadSignals {
  hiring?: { count: number; sources: string[]; checked_at: string }
  permits_30d?: { count: number; checked_at: string }
  last_gbp_post_at?: string
  last_review_at?: string
}

export interface QualityScore {
  total: number       // 0-100
  gbp: number         // 0-25
  license: number     // 0-20
  decision_maker: number  // 0-20
  intent: number      // 0-20
  reachability: number  // 0-15
  computed_at: string
}

export interface LeadRecord {
  // Identity
  domain: string
  business_name: string
  city: string
  state: string  // default 'FL'
  niche: string

  // Contact + people
  phone: string
  website: string
  emails: LeadEmail[]
  decision_maker?: DecisionMaker

  // GBP
  gbp_url: string
  gbp_score: number       // current scoring (0-10)
  category: string
  rating: number
  reviews_count: number
  photo_count: number

  // External signals
  license?: FloridaLicense
  signals?: LeadSignals

  // Composite quality score (V2 — added in punch list item #6)
  quality?: QualityScore

  // Funnel status
  status: LeadStatus
  dnc: boolean
  dnc_reason?: 'unsubscribed' | 'bounced' | 'negative' | 'manual' | 'replied' | 'client'

  // Provenance
  sources: Array<{ name: string; discovered_at: string }>

  // Timeline
  first_seen_at: string
  last_updated_at: string
  last_contacted_at?: string
  last_reply_at?: string
}

export interface LeadEvent {
  at: string
  type: 'scrape' | 'enrich' | 'license_check' | 'email_sent' | 'reply_received' | 'queued' | 'paused' | 'noted' | 'dnc'
  source?: string
  details?: Record<string, unknown>
}

interface IndexEntry {
  domain: string
  business_name: string
  city: string
  niche: string
  status: LeadStatus
  dnc: boolean
  quality_total?: number
  last_contacted_at?: string
  last_updated_at: string
}

type Index = Record<string, IndexEntry>

// =====================================================================
// KEYS
// =====================================================================

const INDEX_KEY = 'mimir:leads:index'
const DNC_KEY = 'mimir:leads:dnc'
const RECORD_KEY = (domain: string) => `mimir:leads:${hashKey(domain)}`
const EVENTS_KEY = (domain: string) => `mimir:leads:${hashKey(domain)}:events`
const MAX_EVENTS_KEPT = 200

// =====================================================================
// NORMALIZATION
// =====================================================================

/**
 * Stable domain key. "https://www.BartowRoofing.com/contact" → "bartowroofing.com"
 */
export function normalizeDomain(input: string): string {
  if (!input) return ''
  let s = input.trim().toLowerCase()
  s = s.replace(/^https?:\/\//, '')
  s = s.replace(/^www\./, '')
  s = s.split('/')[0] ?? ''
  return s
}

// =====================================================================
// INDEX HELPERS
// =====================================================================

async function loadIndex(): Promise<Index> {
  const stored = await kv().get<Index>(INDEX_KEY)
  return (stored && typeof stored === 'object') ? stored : {}
}

async function saveIndex(idx: Index): Promise<void> {
  await kv().set(INDEX_KEY, idx)
}

async function loadDnc(): Promise<Set<string>> {
  const arr = await kv().get<string[]>(DNC_KEY)
  return new Set(Array.isArray(arr) ? arr : [])
}

async function saveDnc(set: Set<string>): Promise<void> {
  await kv().set(DNC_KEY, [...set])
}

function indexEntryFor(record: LeadRecord): IndexEntry {
  const entry: IndexEntry = {
    domain: record.domain,
    business_name: record.business_name,
    city: record.city,
    niche: record.niche,
    status: record.status,
    dnc: record.dnc,
    last_updated_at: record.last_updated_at,
  }
  if (record.quality?.total !== undefined) entry.quality_total = record.quality.total
  if (record.last_contacted_at) entry.last_contacted_at = record.last_contacted_at
  return entry
}

// =====================================================================
// COMPOSITE QUALITY SCORE (V2 — replaces single GBP score for queue gating)
// =====================================================================
//
// Total = GBP (25) + License (20) + Decision-maker (20) + Intent (20) + Reachability (15)
// 60+ = auto-queue eligible. 80+ = top-tier lead, prioritize.
//
// Intent stays mostly 0 until #7 (hiring + permit signals) ships. Leads
// can still hit 80 from the other four sub-scores alone, so the score is
// meaningful today and gets sharper as signals come online.

export function computeQualityScore(lead: LeadRecord): QualityScore {
  // ---- GBP (max 25) ----
  let gbp = 0
  if (lead.reviews_count >= 100) gbp += 10
  else if (lead.reviews_count >= 50) gbp += 7
  else if (lead.reviews_count >= 20) gbp += 4
  if (lead.photo_count >= 50) gbp += 7
  else if (lead.photo_count >= 25) gbp += 5
  else if (lead.photo_count >= 10) gbp += 3
  if (lead.rating >= 4.8) gbp += 8
  else if (lead.rating >= 4.5) gbp += 5
  else if (lead.rating >= 4.0) gbp += 3
  gbp = Math.min(25, gbp)

  // ---- License (max 20) ----
  let license = 0
  if (lead.license) {
    if (lead.license.status === 'active') license += 10
    else if (lead.license.status === 'expired') license += 3
    const tenure = lead.license.years_tenure ?? 0
    if (tenure >= 10) license += 8
    else if (tenure >= 4) license += 4
    else if (tenure >= 1) license += 2
    if (lead.license.discipline_count === 0) license += 2
  }
  license = Math.min(20, license)

  // ---- Decision-maker (max 20) ----
  let dm = 0
  if (lead.decision_maker) {
    if (lead.decision_maker.first_name && lead.decision_maker.last_name) dm += 5
    const title = (lead.decision_maker.title ?? '').toLowerCase()
    if (/owner|principal|president|founder|partner|ceo/.test(title)) dm += 10
    else if (/manager|director|operations|vp/.test(title)) dm += 5
    else if (title) dm += 2
    if (lead.decision_maker.linkedin_url) dm += 3
    dm += Math.round((lead.decision_maker.confidence ?? 0) * 5)
  }
  dm = Math.min(20, dm)

  // ---- Intent (max 20) — mostly 0 until #7 ----
  let intent = 0
  if (lead.signals) {
    if (lead.signals.hiring && lead.signals.hiring.count > 0) intent += 6
    if (lead.signals.permits_30d && lead.signals.permits_30d.count > 0) intent += 8
    if (lead.signals.last_gbp_post_at) {
      const days = (Date.now() - new Date(lead.signals.last_gbp_post_at).getTime()) / (24 * 3600 * 1000)
      if (days <= 60) intent += 4
    }
    if (lead.signals.last_review_at) {
      const days = (Date.now() - new Date(lead.signals.last_review_at).getTime()) / (24 * 3600 * 1000)
      if (days <= 30) intent += 2
    }
  }
  intent = Math.min(20, intent)

  // ---- Reachability (max 15) ----
  let reachability = 0
  const verifiedEmail = lead.emails.find(e => e.verification === 'ok')
  if (verifiedEmail) reachability += 8
  else if (lead.emails.length > 0) reachability += 3
  if (lead.phone) reachability += 4
  if (lead.last_reply_at) reachability += 3  // historical engagement signal
  reachability = Math.min(15, reachability)

  return {
    total: gbp + license + dm + intent + reachability,
    gbp,
    license,
    decision_maker: dm,
    intent,
    reachability,
    computed_at: new Date().toISOString(),
  }
}

// =====================================================================
// CORE CRUD
// =====================================================================

export async function getLead(domainInput: string): Promise<LeadRecord | null> {
  const domain = normalizeDomain(domainInput)
  if (!domain) return null
  return kv().get<LeadRecord>(RECORD_KEY(domain))
}

/**
 * Merge new data into an existing record, or create one. Returns the post-merge
 * record. Index is kept in sync.
 *
 * Merge rules: scalars overwrite (if provided), emails dedupe by value,
 * sources accumulate, signals + license shallow-merge.
 */
export async function upsertLead(partial: Partial<LeadRecord> & { domain: string }): Promise<LeadRecord> {
  const domain = normalizeDomain(partial.domain)
  if (!domain) throw new Error('upsertLead: domain required')
  const now = new Date().toISOString()
  const existing = await getLead(domain)

  const merged: LeadRecord = existing
    ? mergeRecords(existing, { ...partial, domain })
    : {
        // defaults for a brand-new record
        domain,
        business_name: partial.business_name ?? '',
        city: partial.city ?? '',
        state: partial.state ?? 'FL',
        niche: partial.niche ?? '',
        phone: partial.phone ?? '',
        website: partial.website ?? '',
        emails: partial.emails ?? [],
        gbp_url: partial.gbp_url ?? '',
        gbp_score: partial.gbp_score ?? 0,
        category: partial.category ?? '',
        rating: partial.rating ?? 0,
        reviews_count: partial.reviews_count ?? 0,
        photo_count: partial.photo_count ?? 0,
        status: partial.status ?? 'new',
        dnc: partial.dnc ?? false,
        sources: partial.sources ?? [{ name: 'unknown', discovered_at: now }],
        first_seen_at: now,
        last_updated_at: now,
        ...(partial.decision_maker ? { decision_maker: partial.decision_maker } : {}),
        ...(partial.license ? { license: partial.license } : {}),
        ...(partial.signals ? { signals: partial.signals } : {}),
        ...(partial.quality ? { quality: partial.quality } : {}),
        ...(partial.dnc_reason ? { dnc_reason: partial.dnc_reason } : {}),
        ...(partial.last_contacted_at ? { last_contacted_at: partial.last_contacted_at } : {}),
        ...(partial.last_reply_at ? { last_reply_at: partial.last_reply_at } : {}),
      }
  merged.last_updated_at = now

  // Recompute composite quality score on every save — keeps the index sortable
  // and the auto-queue gate honest. Cheap (pure function).
  merged.quality = computeQualityScore(merged)

  await kv().set(RECORD_KEY(domain), merged)

  // Update index
  const idx = await loadIndex()
  idx[domain] = indexEntryFor(merged)
  await saveIndex(idx)

  // Maintain DNC set
  const dnc = await loadDnc()
  if (merged.dnc) dnc.add(domain)
  else dnc.delete(domain)
  await saveDnc(dnc)

  return merged
}

function mergeRecords(existing: LeadRecord, incoming: Partial<LeadRecord> & { domain: string }): LeadRecord {
  const out: LeadRecord = { ...existing }
  const set = <K extends keyof LeadRecord>(k: K, v: LeadRecord[K] | undefined): void => {
    if (v !== undefined && v !== null && v !== '') out[k] = v
  }
  set('business_name', incoming.business_name)
  set('city', incoming.city)
  set('state', incoming.state)
  set('niche', incoming.niche)
  set('phone', incoming.phone)
  set('website', incoming.website)
  set('gbp_url', incoming.gbp_url)
  set('category', incoming.category)
  if (incoming.gbp_score !== undefined) out.gbp_score = incoming.gbp_score
  if (incoming.rating !== undefined) out.rating = incoming.rating
  if (incoming.reviews_count !== undefined) out.reviews_count = incoming.reviews_count
  if (incoming.photo_count !== undefined) out.photo_count = incoming.photo_count
  if (incoming.status) out.status = incoming.status
  if (incoming.dnc !== undefined) out.dnc = incoming.dnc
  if (incoming.dnc_reason) out.dnc_reason = incoming.dnc_reason
  if (incoming.last_contacted_at) out.last_contacted_at = incoming.last_contacted_at
  if (incoming.last_reply_at) out.last_reply_at = incoming.last_reply_at

  // Emails: dedupe by value; incoming verification/source overrides
  if (incoming.emails?.length) {
    const map = new Map<string, LeadEmail>(out.emails.map(e => [e.value.toLowerCase(), e]))
    for (const e of incoming.emails) map.set(e.value.toLowerCase(), { ...map.get(e.value.toLowerCase()), ...e })
    out.emails = [...map.values()]
  }
  if (incoming.decision_maker) out.decision_maker = incoming.decision_maker
  if (incoming.license) out.license = { ...out.license, ...incoming.license }
  if (incoming.signals) out.signals = { ...out.signals, ...incoming.signals }
  if (incoming.quality) out.quality = incoming.quality

  // Sources accumulate, dedup by name
  if (incoming.sources?.length) {
    const seen = new Set(out.sources.map(s => s.name))
    for (const s of incoming.sources) if (!seen.has(s.name)) out.sources.push(s)
  }
  return out
}

// =====================================================================
// EVENTS (interaction log)
// =====================================================================

export async function recordInteraction(domainInput: string, event: Omit<LeadEvent, 'at'>): Promise<void> {
  const domain = normalizeDomain(domainInput)
  if (!domain) return
  const ev: LeadEvent = { at: new Date().toISOString(), ...event }
  await kv().rpush(EVENTS_KEY(domain), ev)
  await kv().ltrim(EVENTS_KEY(domain), -MAX_EVENTS_KEPT, -1)
}

export async function getInteractions(domainInput: string, limit = 50): Promise<LeadEvent[]> {
  const domain = normalizeDomain(domainInput)
  if (!domain) return []
  const list = await kv().lrange<LeadEvent>(EVENTS_KEY(domain), -limit, -1)
  return list.reverse()
}

// =====================================================================
// SUPPRESSION / DNC
// =====================================================================

/**
 * Fast O(1) check before any send or queue operation.
 * Backed by the dedicated DNC set; doesn't require reading the full record.
 */
export async function isSuppressed(domainInput: string): Promise<boolean> {
  const domain = normalizeDomain(domainInput)
  if (!domain) return false
  const dnc = await loadDnc()
  return dnc.has(domain)
}

export async function markDoNotContact(
  domainInput: string,
  reason: 'unsubscribed' | 'bounced' | 'negative' | 'manual' | 'replied' | 'client',
): Promise<boolean> {
  const domain = normalizeDomain(domainInput)
  if (!domain) return false
  const existing = await getLead(domain)
  await upsertLead({
    domain,
    business_name: existing?.business_name ?? domain,
    dnc: true,
    dnc_reason: reason,
    status: reason === 'client' ? 'client'
      : reason === 'unsubscribed' ? 'unsubscribed'
      : reason === 'bounced' ? 'bounced'
      : reason === 'replied' ? 'replied_positive'
      : 'do_not_contact',
  })
  await recordInteraction(domain, { type: 'dnc', details: { reason } })
  return true
}

export async function suppressionList(): Promise<{ count: number; domains: string[] }> {
  const dnc = await loadDnc()
  return { count: dnc.size, domains: [...dnc] }
}

/**
 * History-aware send guard. Default cooldown: 90 days between any contact attempts.
 * Returns null if safe to send; an explanation string if blocked.
 */
export async function blockedFromContact(domainInput: string, cooldownDays = 90): Promise<string | null> {
  const domain = normalizeDomain(domainInput)
  if (!domain) return null
  if (await isSuppressed(domain)) return 'on do-not-contact list'
  const rec = await getLead(domain)
  if (!rec?.last_contacted_at) return null
  const last = new Date(rec.last_contacted_at).getTime()
  const cooldownMs = cooldownDays * 24 * 3600 * 1000
  if (Date.now() - last < cooldownMs) {
    const daysAgo = Math.floor((Date.now() - last) / (24 * 3600 * 1000))
    return `contacted ${daysAgo} day${daysAgo === 1 ? '' : 's'} ago (cooldown ${cooldownDays}d)`
  }
  return null
}

// =====================================================================
// LISTING / FILTERING
// =====================================================================

export interface ListLeadsFilter {
  status?: LeadStatus | LeadStatus[]
  city?: string
  niche?: string
  dnc?: boolean
  min_quality?: number
  limit?: number
}

export async function listLeads(filter: ListLeadsFilter = {}): Promise<{ count: number; total: number; leads: IndexEntry[] }> {
  const idx = await loadIndex()
  let entries = Object.values(idx)
  const total = entries.length

  if (filter.status) {
    const wanted = Array.isArray(filter.status) ? new Set(filter.status) : new Set([filter.status])
    entries = entries.filter(e => wanted.has(e.status))
  }
  if (filter.city) {
    const c = filter.city.toLowerCase()
    entries = entries.filter(e => e.city.toLowerCase().includes(c))
  }
  if (filter.niche) {
    const n = filter.niche.toLowerCase()
    entries = entries.filter(e => e.niche.toLowerCase().includes(n))
  }
  if (filter.dnc !== undefined) entries = entries.filter(e => e.dnc === filter.dnc)
  if (filter.min_quality !== undefined) entries = entries.filter(e => (e.quality_total ?? 0) >= filter.min_quality!)

  // newest first
  entries.sort((a, b) => b.last_updated_at.localeCompare(a.last_updated_at))
  const limit = filter.limit ?? 50
  return { count: Math.min(entries.length, limit), total, leads: entries.slice(0, limit) }
}

/**
 * Recompute quality scores for every record in the DB. Useful after the score
 * formula changes or to backfill legacy records (loaded before the score
 * existed). Returns the number of leads recomputed and the distribution.
 */
export async function recomputeAllQualityScores(): Promise<{
  count: number
  by_bucket: Record<string, number>
  top_5: Array<{ domain: string; business_name: string; quality_total: number }>
}> {
  const idx = await loadIndex()
  const buckets: Record<string, number> = { '0-19': 0, '20-39': 0, '40-59': 0, '60-79': 0, '80-100': 0 }
  const top: Array<{ domain: string; business_name: string; quality_total: number }> = []

  for (const entry of Object.values(idx)) {
    const full = await getLead(entry.domain)
    if (!full) continue
    const q = computeQualityScore(full)
    full.quality = q
    full.last_updated_at = new Date().toISOString()
    await kv().set(RECORD_KEY(entry.domain), full)
    idx[entry.domain] = indexEntryFor(full)
    const t = q.total
    if (t < 20) buckets['0-19']!++
    else if (t < 40) buckets['20-39']!++
    else if (t < 60) buckets['40-59']!++
    else if (t < 80) buckets['60-79']!++
    else buckets['80-100']!++
    top.push({ domain: entry.domain, business_name: full.business_name, quality_total: t })
  }

  await saveIndex(idx)
  top.sort((a, b) => b.quality_total - a.quality_total)
  return { count: Object.keys(idx).length, by_bucket: buckets, top_5: top.slice(0, 5) }
}

export async function databaseStats(): Promise<{
  total: number
  by_status: Record<string, number>
  by_city: Record<string, number>
  by_niche: Record<string, number>
  suppressed: number
  with_license: number
  with_decision_maker: number
}> {
  const idx = await loadIndex()
  const dnc = await loadDnc()
  const by_status: Record<string, number> = {}
  const by_city: Record<string, number> = {}
  const by_niche: Record<string, number> = {}
  for (const e of Object.values(idx)) {
    by_status[e.status] = (by_status[e.status] ?? 0) + 1
    if (e.city) by_city[e.city] = (by_city[e.city] ?? 0) + 1
    if (e.niche) by_niche[e.niche] = (by_niche[e.niche] ?? 0) + 1
  }
  // license / DM counts require reading records — for stats we estimate from index status alone
  // (full count would require N reads, which is fine for ~500 leads; defer until we hit scale)
  return {
    total: Object.keys(idx).length,
    by_status,
    by_city,
    by_niche,
    suppressed: dnc.size,
    with_license: 0,        // TODO: O(N) scan or maintain in index
    with_decision_maker: 0, // TODO: same
  }
}
