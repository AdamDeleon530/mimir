/**
 * LinkedIn decision-maker enrichment.
 *
 * Given a lead (company name + city), find the owner / president / founder /
 * principal on LinkedIn and attach a DecisionMaker record. Strong DM data
 * drops the failure mode where an email opens with "Hi there" — Mimir can
 * lead with the actual person's name.
 *
 * Implementation: Apify actor that searches LinkedIn for company employees
 * matching owner-level titles. Configurable via NUXT_APIFY_LINKEDIN_ACTOR.
 * Default is a community actor — swap if it stops working.
 *
 * Cost: typically $0.02-0.10 per lookup. For 200 leads = $4-20 total — well
 * worth it for the quality bump.
 */
import { upsertLead, getLead, normalizeDomain, recordInteraction } from './lead-db'
import type { DecisionMaker } from './lead-db'

const DEFAULT_LINKEDIN_ACTOR = 'apimaestro~linkedin-company-employees'

const OWNER_LEVEL_PATTERNS: RegExp[] = [
  /\b(owner|co-owner)\b/i,
  /\b(founder|co-founder)\b/i,
  /\b(president|vice president|vp)\b/i,
  /\b(principal)\b/i,
  /\b(ceo|chief executive)\b/i,
  /\b(managing partner|managing director|md)\b/i,
  /\b(partner)\b/i,
]

const MANAGER_LEVEL_PATTERNS: RegExp[] = [
  /\b(general manager|gm)\b/i,
  /\b(operations manager|ops manager)\b/i,
  /\b(director)\b/i,
  /\b(manager)\b/i,
]

export interface IdentifyDmInput {
  domain: string
  business_name?: string
  city?: string
  max_results?: number
}

export interface IdentifyDmResult {
  ok: boolean
  domain: string
  found: boolean
  decision_maker?: DecisionMaker
  candidates?: Array<{ name: string; title: string; linkedin_url?: string }>
  note?: string
}

interface LinkedinRawPerson {
  fullName?: string
  firstName?: string
  lastName?: string
  title?: string
  position?: string
  headline?: string
  publicIdentifier?: string
  profileUrl?: string
  linkedinUrl?: string
  url?: string
}

export async function identifyDecisionMaker(input: IdentifyDmInput): Promise<IdentifyDmResult> {
  const domain = normalizeDomain(input.domain)
  if (!domain) return { ok: false, domain: '', found: false, note: 'invalid domain' }

  // Pull business name from DB if not provided
  let businessName = input.business_name
  let city = input.city
  if (!businessName || !city) {
    const lead = await getLead(domain)
    businessName = businessName ?? lead?.business_name ?? ''
    city = city ?? lead?.city ?? ''
  }
  if (!businessName) {
    return { ok: false, domain, found: false, note: 'no business name available — pass business_name or upsert the lead first' }
  }

  const apifyToken = process.env.NUXT_APIFY_API_TOKEN
  if (!apifyToken) {
    return { ok: false, domain, found: false, note: 'NUXT_APIFY_API_TOKEN not set' }
  }
  const actor = process.env.NUXT_APIFY_LINKEDIN_ACTOR ?? DEFAULT_LINKEDIN_ACTOR
  const maxResults = Math.min(input.max_results ?? 10, 25)

  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${apifyToken}&timeout=180`

  let rawRows: LinkedinRawPerson[] = []
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Different LinkedIn actors take slightly different inputs; send what we know
        companyName: businessName,
        location: city ? `${city}, FL` : 'Florida',
        keywords: 'owner OR founder OR president OR principal OR partner',
        limit: maxResults,
        maxItems: maxResults,
      }),
    })
    if (!res.ok) {
      return { ok: false, domain, found: false, note: `LinkedIn actor returned ${res.status}` }
    }
    rawRows = await res.json() as LinkedinRawPerson[]
    if (!Array.isArray(rawRows)) rawRows = []
  } catch (err) {
    return { ok: false, domain, found: false, note: `LinkedIn actor failed: ${err instanceof Error ? err.message : 'unknown'}` }
  }

  if (rawRows.length === 0) {
    return {
      ok: true,
      domain,
      found: false,
      candidates: [],
      note: 'no LinkedIn employees found for this company',
    }
  }

  // Score candidates by title — owner-level wins
  const scored = rawRows
    .map(p => normalizePerson(p))
    .filter(p => p.first_name && p.last_name)
    .map(p => ({ person: p, score: scorePersonTitle(p.title) }))
    .sort((a, b) => b.score.confidence - a.score.confidence)

  const best = scored[0]
  if (!best || best.score.confidence < 0.5) {
    return {
      ok: true,
      domain,
      found: false,
      candidates: scored.slice(0, 5).map(s => ({ name: `${s.person.first_name} ${s.person.last_name}`, title: s.person.title, ...(s.person.linkedin_url ? { linkedin_url: s.person.linkedin_url } : {}) })),
      note: 'no high-confidence owner-level match — pick from candidates or attach manually',
    }
  }

  const dm: DecisionMaker = {
    first_name: best.person.first_name,
    last_name: best.person.last_name,
    title: best.person.title,
    ...(best.person.linkedin_url ? { linkedin_url: best.person.linkedin_url } : {}),
    source: 'linkedin',
    confidence: best.score.confidence,
  }

  // Persist
  try {
    const existing = await getLead(domain)
    await upsertLead({
      domain,
      business_name: existing?.business_name ?? businessName,
      decision_maker: dm,
    })
    await recordInteraction(domain, {
      type: 'enrich',
      source: 'linkedin',
      details: { name: `${dm.first_name} ${dm.last_name}`, title: dm.title, confidence: dm.confidence },
    })
  } catch { /* best-effort persist */ }

  return {
    ok: true,
    domain,
    found: true,
    decision_maker: dm,
    candidates: scored.slice(0, 3).map(s => ({ name: `${s.person.first_name} ${s.person.last_name}`, title: s.person.title, ...(s.person.linkedin_url ? { linkedin_url: s.person.linkedin_url } : {}) })),
  }
}

// =====================================================================
// HELPERS
// =====================================================================

interface NormalizedPerson {
  first_name: string
  last_name: string
  title: string
  linkedin_url?: string
}

function normalizePerson(raw: LinkedinRawPerson): NormalizedPerson {
  let first_name = raw.firstName ?? ''
  let last_name = raw.lastName ?? ''
  if (!first_name && !last_name && raw.fullName) {
    const parts = raw.fullName.trim().split(/\s+/)
    first_name = parts[0] ?? ''
    last_name = parts.slice(1).join(' ')
  }
  const title = raw.title ?? raw.position ?? raw.headline ?? ''
  const linkedin_url = raw.linkedinUrl ?? raw.profileUrl ?? raw.url
    ?? (raw.publicIdentifier ? `https://www.linkedin.com/in/${raw.publicIdentifier}` : undefined)
  return { first_name, last_name, title, ...(linkedin_url ? { linkedin_url } : {}) }
}

function scorePersonTitle(title: string): { confidence: number; tier: 'owner' | 'manager' | 'other' } {
  for (const p of OWNER_LEVEL_PATTERNS) if (p.test(title)) return { confidence: 0.9, tier: 'owner' }
  for (const p of MANAGER_LEVEL_PATTERNS) if (p.test(title)) return { confidence: 0.55, tier: 'manager' }
  if (title) return { confidence: 0.3, tier: 'other' }
  return { confidence: 0, tier: 'other' }
}
