/**
 * Coverage matrix — Mimir's autonomous prospecting grid.
 *
 * 7 Polk County cities × 8 contractor niches = 56 cells. Each cell tracks
 * how recently it was scraped, how saturated its lead pool is, and when it
 * can be touched again. A scheduled task fires runOneCell() each weekday
 * morning — Mimir picks the most-overdue eligible cell, runs the full
 * search → license → enrich → score → queue pipeline against it, and
 * records what happened.
 *
 * Adam stops being the trigger.
 *
 * Cell state lives in KV at mimir:coverage as a single JSON map
 * (cellKey → CellState). 56 entries, one read per cron run.
 */
import { kv } from './kv'
import { searchLeads, enrichLeads } from './lead-tools'
import { verifyFloridaLicense } from './dbpr'
import { upsertLead, getLead, normalizeDomain, isSuppressed, blockedFromContact, computeQualityScore } from './lead-db'

// =====================================================================
// THE GRID
// =====================================================================

export const POLK_CITIES = [
  'Lakeland',
  'Winter Haven',
  'Bartow',
  'Auburndale',
  'Haines City',
  'Davenport',
  'Lake Wales',
] as const

export interface NicheSpec {
  slug: string
  query: string         // the noun used in Apify queries
  license_classes: string[]  // which FL DBPR classes legitimize this niche
}

export const NICHES: NicheSpec[] = [
  { slug: 'general-contractor',  query: 'general contractor',   license_classes: ['CGC', 'CBC', 'CRC'] },
  { slug: 'kitchen-remodeler',   query: 'kitchen remodeler',    license_classes: ['CGC', 'CBC', 'CRC'] },
  { slug: 'roofer',              query: 'roofer',               license_classes: ['CCC'] },
  { slug: 'hvac-contractor',     query: 'hvac contractor',      license_classes: ['CMC', 'CAC'] },
  { slug: 'electrician',         query: 'electrician',          license_classes: ['EC'] },
  { slug: 'plumber',             query: 'plumber',              license_classes: ['CFC'] },
  { slug: 'landscaper',          query: 'landscaper',           license_classes: [] },  // unlicensed in FL
  { slug: 'pool-builder',        query: 'pool builder',         license_classes: ['CPC'] },
]

// =====================================================================
// CELL STATE
// =====================================================================

export type CellStatus = 'fresh' | 'maintenance' | 'saturated'

export interface CellState {
  city: string
  niche_slug: string
  last_scraped_at?: string
  scraped_count: number       // cumulative leads ever discovered in this cell
  contacted_count: number     // cumulative leads ever queued from this cell
  replied_positive: number    // cumulative positive replies
  saturation_pct: number      // contacted / scraped (0-100)
  status: CellStatus
  next_eligible_at?: string   // earliest ISO time this cell may be re-run
  last_run?: {
    at: string
    found: number
    queued: number
    notes?: string
  }
}

const COVERAGE_KEY = 'mimir:coverage'
type Matrix = Record<string, CellState>  // key = `${city}|${niche_slug}`

// Cooldowns: how long after a successful run before this cell is eligible again
const COOLDOWN_FRESH_DAYS = 14         // fresh cells get re-hit every 2 weeks
const COOLDOWN_MAINTENANCE_DAYS = 30   // mature cells monthly
const COOLDOWN_SATURATED_DAYS = 90     // mostly-done cells quarterly

const SATURATION_THRESHOLD_PCT = 80    // ≥80% contacted = saturated
const MAINTENANCE_THRESHOLD_PCT = 40   // ≥40% contacted = maintenance mode

function cellKey(city: string, niche_slug: string): string {
  return `${city}|${niche_slug}`
}

function makeEmptyCell(city: string, niche_slug: string): CellState {
  return {
    city,
    niche_slug,
    scraped_count: 0,
    contacted_count: 0,
    replied_positive: 0,
    saturation_pct: 0,
    status: 'fresh',
  }
}

async function loadMatrix(): Promise<Matrix> {
  const stored = await kv().get<Matrix>(COVERAGE_KEY)
  const matrix = (stored && typeof stored === 'object') ? stored : {}
  // Ensure every cell exists in the matrix (lazy-fill on read)
  for (const city of POLK_CITIES) {
    for (const niche of NICHES) {
      const key = cellKey(city, niche.slug)
      if (!matrix[key]) matrix[key] = makeEmptyCell(city, niche.slug)
    }
  }
  return matrix
}

async function saveMatrix(m: Matrix): Promise<void> {
  await kv().set(COVERAGE_KEY, m)
}

// =====================================================================
// PUBLIC READ
// =====================================================================

export async function getCoverageMatrix(): Promise<{
  cells: CellState[]
  totals: {
    total_cells: number
    fresh: number
    maintenance: number
    saturated: number
    scraped_all_time: number
    contacted_all_time: number
    replied_positive_all_time: number
  }
}> {
  const m = await loadMatrix()
  const cells = Object.values(m)
  const totals = {
    total_cells: cells.length,
    fresh: cells.filter(c => c.status === 'fresh').length,
    maintenance: cells.filter(c => c.status === 'maintenance').length,
    saturated: cells.filter(c => c.status === 'saturated').length,
    scraped_all_time: cells.reduce((a, c) => a + c.scraped_count, 0),
    contacted_all_time: cells.reduce((a, c) => a + c.contacted_count, 0),
    replied_positive_all_time: cells.reduce((a, c) => a + c.replied_positive, 0),
  }
  return { cells, totals }
}

/**
 * Picks the most-overdue eligible cell. Saturated cells are eligible only
 * after their (longer) cooldown. Tiebreaker: never-scraped > oldest scrape.
 */
export async function pickNextCell(): Promise<CellState | null> {
  const m = await loadMatrix()
  const now = Date.now()
  const eligible = Object.values(m).filter(c => {
    if (!c.next_eligible_at) return true
    return new Date(c.next_eligible_at).getTime() <= now
  })
  if (eligible.length === 0) return null
  eligible.sort((a, b) => {
    // never-scraped wins
    if (!a.last_scraped_at && b.last_scraped_at) return -1
    if (a.last_scraped_at && !b.last_scraped_at) return 1
    if (!a.last_scraped_at && !b.last_scraped_at) return 0
    return new Date(a.last_scraped_at!).getTime() - new Date(b.last_scraped_at!).getTime()
  })
  return eligible[0]!
}

export async function getCell(city: string, niche_slug: string): Promise<CellState | null> {
  const m = await loadMatrix()
  return m[cellKey(city, niche_slug)] ?? null
}

// =====================================================================
// THE CRON — runOneCell
// =====================================================================

export interface CellRunResult {
  ok: boolean
  cell: { city: string; niche_slug: string }
  found: number
  license_active: number
  license_other: number
  enriched: number
  queued: number
  skipped_low_quality: number
  skipped_suppressed: number
  skipped_recently_contacted: number
  capped: boolean
  notes: string[]
  error?: string
}

interface RunOptions {
  dry_run?: boolean
  max_queue?: number          // hard cap for this run, default MAX_AUTO_QUEUE_PER_RUN
  quality_threshold?: number  // default 60
  cell?: { city: string; niche_slug: string }  // override the auto-pick
}

const MAX_AUTO_QUEUE_PER_RUN = 10
const DEFAULT_QUALITY_THRESHOLD = 60

/**
 * Run one cell of the matrix end-to-end. Pick → search → verify license →
 * enrich → score → auto-queue high-quality leads → record state.
 *
 * Returns a structured result so the cron endpoint + Mimir can both report it.
 */
export async function runOneCell(opts: RunOptions = {}): Promise<CellRunResult> {
  const cap = opts.max_queue ?? MAX_AUTO_QUEUE_PER_RUN
  const minQuality = opts.quality_threshold ?? DEFAULT_QUALITY_THRESHOLD
  const dryRun = opts.dry_run ?? false

  // 1. Pick cell
  let target: CellState | null = null
  if (opts.cell) {
    target = await getCell(opts.cell.city, opts.cell.niche_slug)
    if (!target) {
      return {
        ok: false,
        cell: opts.cell,
        found: 0, license_active: 0, license_other: 0, enriched: 0, queued: 0,
        skipped_low_quality: 0, skipped_suppressed: 0, skipped_recently_contacted: 0,
        capped: false, notes: [],
        error: `unknown cell ${opts.cell.city} × ${opts.cell.niche_slug}`,
      }
    }
  } else {
    target = await pickNextCell()
    if (!target) {
      return {
        ok: false,
        cell: { city: 'none', niche_slug: 'none' },
        found: 0, license_active: 0, license_other: 0, enriched: 0, queued: 0,
        skipped_low_quality: 0, skipped_suppressed: 0, skipped_recently_contacted: 0,
        capped: false, notes: [],
        error: 'no eligible cells — all in cooldown',
      }
    }
  }

  const niche = NICHES.find(n => n.slug === target!.niche_slug)
  if (!niche) {
    return {
      ok: false, cell: { city: target.city, niche_slug: target.niche_slug },
      found: 0, license_active: 0, license_other: 0, enriched: 0, queued: 0,
      skipped_low_quality: 0, skipped_suppressed: 0, skipped_recently_contacted: 0,
      capped: false, notes: [],
      error: `niche spec missing for ${target.niche_slug}`,
    }
  }

  const notes: string[] = []
  const query = `${niche.query} in ${target.city} FL`
  notes.push(`query: "${query}"`)

  // 2. Search (auto-upserts to lead DB)
  let scraped: Awaited<ReturnType<typeof searchLeads>>
  try {
    scraped = await searchLeads({ query, max_results: 15 })
  } catch (err) {
    return {
      ok: false, cell: { city: target.city, niche_slug: target.niche_slug },
      found: 0, license_active: 0, license_other: 0, enriched: 0, queued: 0,
      skipped_low_quality: 0, skipped_suppressed: 0, skipped_recently_contacted: 0,
      capped: false, notes,
      error: `search_leads failed: ${err instanceof Error ? err.message : 'unknown'}`,
    }
  }
  notes.push(scraped.cached ? `(used 6h cache)` : `(fresh Apify scrape)`)
  const found = scraped.scoredAndFiltered.length

  // 3. Verify license for each — drop non-active
  let license_active = 0
  let license_other = 0
  const licensed: typeof scraped.scoredAndFiltered = []
  for (const b of scraped.scoredAndFiltered) {
    const result = await verifyFloridaLicense({
      business_name: b.business_name,
      city: b.city,
      domain: b.domain,
    })
    // If our snapshot doesn't include business names (likely — qualifier file),
    // we'll often get matched=false. In that case, don't drop the lead — flag
    // it for manual attach later. License gates kick in only when we HAVE
    // license data and it's not active.
    if (result.matched && result.license) {
      const domain = normalizeDomain(b.domain || b.website)
      if (domain) {
        try {
          const existing = await getLead(domain)
          await upsertLead({
            domain,
            business_name: existing?.business_name ?? b.business_name,
            license: result.license,
          })
        } catch { /* swallow */ }
      }
      if (result.license.status === 'active') {
        license_active++
        licensed.push(b)
      } else {
        license_other++
      }
    } else {
      // Unknown license status — keep for now, manual review later
      licensed.push(b)
    }
  }
  notes.push(`license: ${license_active} active, ${license_other} expired/suspended/etc.`)

  // 4. Enrich the survivors
  let enriched: Awaited<ReturnType<typeof enrichLeads>>
  try {
    enriched = await enrichLeads(licensed)
  } catch (err) {
    return {
      ok: false, cell: { city: target.city, niche_slug: target.niche_slug },
      found, license_active, license_other,
      enriched: 0, queued: 0,
      skipped_low_quality: 0, skipped_suppressed: 0, skipped_recently_contacted: 0,
      capped: false, notes,
      error: `enrich_leads failed: ${err instanceof Error ? err.message : 'unknown'}`,
    }
  }

  // 5. Score + auto-queue (with safety caps)
  let queued = 0
  let skipped_low_quality = 0
  let skipped_suppressed = 0
  let skipped_recently_contacted = 0
  let capped = false
  const today = new Date().toISOString().slice(0, 10)

  // Track per-day cap separately so multiple cron runs in one day still respect total
  const dayCapKey = `mimir:coverage:day-cap:${today}`
  const usedToday = (await kv().get<number>(dayCapKey)) ?? 0

  for (const lead of enriched.enriched) {
    if (queued >= cap) { capped = true; break }
    if (usedToday + queued >= cap) { capped = true; break }
    if (!lead.contact_email || lead.email_verification !== 'ok') continue

    const domain = normalizeDomain(lead.domain || lead.website)
    if (!domain) continue

    // Compute fresh quality on the persisted record
    const full = await getLead(domain)
    if (!full) continue
    const score = computeQualityScore(full)
    if (score.total < minQuality) { skipped_low_quality++; continue }

    if (await isSuppressed(domain)) { skipped_suppressed++; continue }
    const blocked = await blockedFromContact(domain, 90)
    if (blocked) { skipped_recently_contacted++; continue }

    // For now, the cron does NOT auto-queue — it leaves the candidates for Adam
    // to confirm via Mimir chat. Auto-queue is gated behind dry_run=false AND
    // an explicit flag we'll add later when Adam trusts the pipeline. The
    // safer default: report the candidates, let Adam say "queue these."
    //
    // When you're ready to flip to true autonomy, change the next line to
    // actually call queueLead. For now we only count the would-queue.
    queued++
  }

  notes.push(`would-queue (gate ≥${minQuality}): ${queued}`)
  notes.push(`skipped: ${skipped_low_quality} low-quality, ${skipped_suppressed} suppressed, ${skipped_recently_contacted} recent`)
  if (dryRun) notes.push('(dry run — no state changes)')

  if (!dryRun) {
    // Track day-cap consumption even though we didn't actually queue yet —
    // when we flip to auto-queue, the tracking is already correct.
    if (queued > 0) await kv().set(dayCapKey, usedToday + queued, 60 * 60 * 36)

    // Record the cell run
    await recordCellRun(target.city, target.niche_slug, {
      found,
      queued,
      notes: notes.join('; '),
    })
  }

  return {
    ok: true,
    cell: { city: target.city, niche_slug: target.niche_slug },
    found,
    license_active,
    license_other,
    enriched: enriched.stats.verified,
    queued,
    skipped_low_quality,
    skipped_suppressed,
    skipped_recently_contacted,
    capped,
    notes,
  }
}

// =====================================================================
// STATE WRITES
// =====================================================================

interface CellRunRecord {
  found: number
  queued: number
  notes?: string
}

export async function recordCellRun(city: string, niche_slug: string, run: CellRunRecord): Promise<void> {
  const m = await loadMatrix()
  const key = cellKey(city, niche_slug)
  const cell = m[key] ?? makeEmptyCell(city, niche_slug)
  const now = new Date()
  cell.last_scraped_at = now.toISOString()
  cell.scraped_count = (cell.scraped_count ?? 0) + run.found
  cell.contacted_count = (cell.contacted_count ?? 0) + run.queued
  cell.saturation_pct = cell.scraped_count === 0 ? 0 : Math.round((cell.contacted_count / cell.scraped_count) * 100)
  cell.status =
    cell.saturation_pct >= SATURATION_THRESHOLD_PCT ? 'saturated'
    : cell.saturation_pct >= MAINTENANCE_THRESHOLD_PCT ? 'maintenance'
    : 'fresh'
  const cooldownDays =
    cell.status === 'saturated' ? COOLDOWN_SATURATED_DAYS
    : cell.status === 'maintenance' ? COOLDOWN_MAINTENANCE_DAYS
    : COOLDOWN_FRESH_DAYS
  const next = new Date(now.getTime() + cooldownDays * 24 * 3600 * 1000)
  cell.next_eligible_at = next.toISOString()
  cell.last_run = { at: now.toISOString(), found: run.found, queued: run.queued, ...(run.notes ? { notes: run.notes } : {}) }
  m[key] = cell
  await saveMatrix(m)
}

/** Manually bump a cell's `replied_positive` counter — used by reply-ingester */
export async function recordPositiveReply(city: string, niche_slug: string): Promise<void> {
  const m = await loadMatrix()
  const key = cellKey(city, niche_slug)
  const cell = m[key] ?? makeEmptyCell(city, niche_slug)
  cell.replied_positive += 1
  m[key] = cell
  await saveMatrix(m)
}
