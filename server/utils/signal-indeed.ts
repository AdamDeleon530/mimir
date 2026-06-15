/**
 * Indeed hiring-signal scraper.
 *
 * A contractor with active job posts is signaling:
 *   1. Active growth — they have revenue confidence to add headcount
 *   2. Operational maturity — small shops without systems can't onboard
 *   3. Marketing budget — growth requires lead flow to feed the new hires
 *
 * Contractors actively hiring respond to cold outreach at 2-3x the baseline.
 * It's the single most actionable intent signal.
 *
 * Implementation: Apify actor that searches Indeed by company name + location.
 * Configurable via NUXT_APIFY_INDEED_ACTOR.
 *
 * The result is attached to lead.signals.hiring with count + checked_at; the
 * composite quality score automatically picks up the intent boost on the next
 * upsertLead (since quality is recomputed on every save).
 */
import { upsertLead, getLead, normalizeDomain, recordInteraction } from './lead-db'
import type { LeadSignals } from './lead-db'

const DEFAULT_INDEED_ACTOR = 'misceres~indeed-scraper'

export interface CheckHiringInput {
  domain: string
  business_name?: string
  city?: string
}

export interface CheckHiringResult {
  ok: boolean
  domain: string
  hiring: { count: number; sources: string[]; checked_at: string }
  job_titles?: string[]
  note?: string
}

interface IndeedJobRecord {
  positionName?: string
  title?: string
  company?: string
  companyName?: string
  location?: string
  url?: string
  jobUrl?: string
  postedDate?: string
  postedAt?: string
}

export async function checkHiringSignal(input: CheckHiringInput): Promise<CheckHiringResult> {
  const domain = normalizeDomain(input.domain)
  if (!domain) return {
    ok: false, domain: '',
    hiring: { count: 0, sources: [], checked_at: new Date().toISOString() },
    note: 'invalid domain',
  }

  // Pull from DB if not supplied
  let businessName = input.business_name
  let city = input.city
  if (!businessName || !city) {
    const lead = await getLead(domain)
    businessName = businessName ?? lead?.business_name ?? ''
    city = city ?? lead?.city ?? ''
  }

  if (!businessName) {
    return {
      ok: false, domain,
      hiring: { count: 0, sources: [], checked_at: new Date().toISOString() },
      note: 'no business name available',
    }
  }

  const apifyToken = process.env.NUXT_APIFY_API_TOKEN
  if (!apifyToken) {
    return {
      ok: false, domain,
      hiring: { count: 0, sources: [], checked_at: new Date().toISOString() },
      note: 'NUXT_APIFY_API_TOKEN not set',
    }
  }

  const actor = process.env.NUXT_APIFY_INDEED_ACTOR ?? DEFAULT_INDEED_ACTOR
  const location = city ? `${city}, FL` : 'Florida'
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${apifyToken}&timeout=120`

  let rows: IndeedJobRecord[] = []
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Search Indeed for jobs at this specific company
        // Different actors take slightly different inputs
        position: businessName,
        company: businessName,
        location,
        country: 'US',
        maxItems: 20,
        maxConcurrency: 1,
      }),
    })
    if (!res.ok) {
      return {
        ok: false, domain,
        hiring: { count: 0, sources: [], checked_at: new Date().toISOString() },
        note: `Indeed actor returned ${res.status}`,
      }
    }
    rows = await res.json() as IndeedJobRecord[]
    if (!Array.isArray(rows)) rows = []
  } catch (err) {
    return {
      ok: false, domain,
      hiring: { count: 0, sources: [], checked_at: new Date().toISOString() },
      note: `Indeed actor failed: ${err instanceof Error ? err.message : 'unknown'}`,
    }
  }

  // Filter to posts that match our company (Indeed search is fuzzy, so dedup by company match)
  const businessLower = businessName.toLowerCase()
  const matched = rows.filter(r => {
    const c = (r.companyName ?? r.company ?? '').toLowerCase()
    return c && (c.includes(businessLower) || businessLower.includes(c))
  })

  const now = new Date().toISOString()
  const hiring = {
    count: matched.length,
    sources: ['indeed'],
    checked_at: now,
  }

  // Persist back to lead DB. signals merge shallow, so this preserves any
  // existing fields like permits_30d.
  try {
    const existing = await getLead(domain)
    const signals: LeadSignals = {
      ...(existing?.signals ?? {}),
      hiring,
    }
    await upsertLead({
      domain,
      business_name: existing?.business_name ?? businessName,
      signals,
    })
    await recordInteraction(domain, {
      type: 'noted',
      source: 'indeed',
      details: { hiring_count: matched.length },
    })
  } catch { /* best-effort */ }

  return {
    ok: true,
    domain,
    hiring,
    job_titles: matched.slice(0, 5).map(r => r.positionName ?? r.title ?? '').filter(t => t),
    ...(matched.length === 0 ? { note: 'no current job posts on Indeed' } : {}),
  }
}
