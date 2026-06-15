/**
 * Lead generation tools for Mimir.
 *
 * The conversational pipeline:
 *   search_leads → enrich_leads → generate_first_lines → push_to_instantly
 *
 * Each call returns under Vercel's 60-second timeout (Pro plan).
 * For very large batches (>20 leads), prefer the n8n batch workflow on the VPS.
 */
import Anthropic from '@anthropic-ai/sdk'
import { memoize, hashKey } from './kv-cache'
import { upsertLead, normalizeDomain, recordInteraction } from './lead-db'
import { searchYelp } from './source-yelp'
import { searchBbb } from './source-bbb'

// ============================================================
// TYPES
// ============================================================

export interface ScrapedBusiness {
  business_name: string
  address: string
  city: string
  state: string
  phone: string
  website: string
  domain: string
  category: string
  rating: number
  reviews_count: number
  photo_count: number
  categories_count: number
  has_recent_posts: boolean
  gbp_url: string
  place_id?: string
}

export interface ScoredBusiness extends ScrapedBusiness {
  gbp_score: number
  score_breakdown: Record<string, number>
}

export interface EnrichedLead extends ScoredBusiness {
  contact_email?: string
  contact_first_name?: string
  contact_last_name?: string
  contact_position?: string
  email_verification?: 'ok' | 'risky' | 'bad' | 'unknown'
  enrichment_note?: string
}

export interface LeadWithFirstLine extends EnrichedLead {
  first_line: string
  first_line_status: 'generated' | 'fallback' | 'skipped'
}

// ============================================================
// 1. SEARCH_LEADS — Apify Google Maps + GBP scoring
// ============================================================

interface SearchInput {
  query: string
  max_results?: number
  score_min?: number
  score_max?: number
}

export async function searchLeads(input: SearchInput): Promise<{
  asOf: string
  query: string
  scrapedCount: number
  scoredAndFiltered: ScoredBusiness[]
  filter: { score_min: number; score_max: number }
  sources_used?: Array<{ name: string; raw_count: number; status: 'ok' | 'empty' | 'skipped' }>
  cached?: boolean
  note?: string
}> {
  // 6-hour memo on the exact (query, max_results, score_range) triple.
  // Saves the ~$0.05 Apify hit when Adam re-runs the same search.
  const cacheKey = `mimir:search:${hashKey(JSON.stringify({
    q: input.query.toLowerCase().trim(),
    n: input.max_results ?? 15,
    smin: input.score_min ?? 3,
    smax: input.score_max ?? 7,
  }))}`
  const { value, cached } = await memoize(cacheKey, 6 * 3600, () => doSearchLeads(input))
  return { ...value, cached }
}

async function doSearchLeads(input: SearchInput): Promise<{
  asOf: string
  query: string
  scrapedCount: number
  scoredAndFiltered: ScoredBusiness[]
  filter: { score_min: number; score_max: number }
  sources_used: Array<{ name: string; raw_count: number; status: 'ok' | 'empty' | 'skipped' }>
  note?: string
}> {
  const apifyToken = process.env.NUXT_APIFY_API_TOKEN
  if (!apifyToken) {
    return {
      asOf: new Date().toISOString(),
      query: input.query,
      scrapedCount: 0,
      scoredAndFiltered: [],
      filter: { score_min: input.score_min ?? 3, score_max: input.score_max ?? 7 },
      sources_used: [],
      note: 'NUXT_APIFY_API_TOKEN not configured. Get one at apify.com → Settings → Integrations → Personal API tokens.',
    }
  }

  const maxResults = Math.min(input.max_results ?? 15, 25)
  const scoreMin = input.score_min ?? 3
  const scoreMax = input.score_max ?? 7

  // Parse the city + niche from the query for the secondary sources.
  // Google Maps takes the full query string; Yelp/BBB need them split.
  const parsed = parseQueryForSources(input.query)

  // Fan out across all three sources in parallel.
  // Each source returns its own ScrapedBusiness[]; we merge by domain.
  const [gmapsResults, yelpResults, bbbResults] = await Promise.all([
    searchGoogleMaps(input.query, maxResults).catch(() => [] as ScrapedBusiness[]),
    parsed.niche && parsed.city
      ? searchYelp({ niche: parsed.niche, city: parsed.city, max_results: maxResults }).catch(() => [] as ScrapedBusiness[])
      : Promise.resolve([] as ScrapedBusiness[]),
    parsed.niche && parsed.city
      ? searchBbb({ niche: parsed.niche, city: parsed.city, max_results: maxResults }).catch(() => [] as ScrapedBusiness[])
      : Promise.resolve([] as ScrapedBusiness[]),
  ])

  const sources_used: Array<{ name: string; raw_count: number; status: 'ok' | 'empty' | 'skipped' }> = [
    { name: 'google_maps', raw_count: gmapsResults.length, status: gmapsResults.length > 0 ? 'ok' : 'empty' },
    { name: 'yelp', raw_count: yelpResults.length, status: parsed.niche ? (yelpResults.length > 0 ? 'ok' : 'empty') : 'skipped' },
    { name: 'bbb', raw_count: bbbResults.length, status: parsed.niche ? (bbbResults.length > 0 ? 'ok' : 'empty') : 'skipped' },
  ]

  // Merge across sources by domain. Keep the record with the most signal
  // (highest review count) when duplicates appear. Union the sources array.
  const merged = mergeBySources([
    { source: 'google_maps', items: gmapsResults },
    { source: 'yelp', items: yelpResults },
    { source: 'bbb', items: bbbResults },
  ])
  const scraped = merged

  return await applyScoringFilterAndPersist({
    scraped,
    query: input.query,
    scoreMin,
    scoreMax,
    sources_used,
  })
}

// =====================================================================
// SOURCE 1: Google Maps via Apify (the original)
// =====================================================================

async function searchGoogleMaps(query: string, maxResults: number): Promise<ScrapedBusiness[]> {
  const apifyToken = process.env.NUXT_APIFY_API_TOKEN
  if (!apifyToken) return []
  const url = `https://api.apify.com/v2/acts/compass~crawler-google-places/run-sync-get-dataset-items?token=${apifyToken}&timeout=270`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      searchStringsArray: [query],
      maxCrawledPlacesPerSearch: maxResults,
      language: 'en',
      countryCode: 'us',
      scrapeContacts: false,
      includeReviews: false,
      includeImages: false,
      maxImages: 0,
      exportPlaceUrls: false,
      additionalInfo: false,
    }),
  })
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Apify error ${res.status}: ${errText.slice(0, 300)}`)
  }
  const raw = await res.json() as Array<Record<string, unknown>>
  return raw.map(normalizeApifyRecord)
}

// =====================================================================
// MULTI-SOURCE MERGE + SCORE + PERSIST
// =====================================================================

interface SourceBucket {
  source: string
  items: ScrapedBusiness[]
}

/**
 * Merge results from multiple sources by domain. When the same business
 * appears in two sources, keep the record with the most signal (highest
 * review count usually = most-maintained listing) and union the source
 * provenance. Records without a domain are kept individually (no merge).
 */
function mergeBySources(buckets: SourceBucket[]): ScrapedBusiness[] {
  const byDomain = new Map<string, { record: ScrapedBusiness; sources: Set<string> }>()
  const noDomain: Array<{ record: ScrapedBusiness; sources: Set<string> }> = []
  for (const bucket of buckets) {
    for (const item of bucket.items) {
      const d = normalizeDomain(item.domain || item.website)
      if (!d) {
        noDomain.push({ record: item, sources: new Set([bucket.source]) })
        continue
      }
      const existing = byDomain.get(d)
      if (!existing) {
        byDomain.set(d, { record: item, sources: new Set([bucket.source]) })
      } else {
        existing.sources.add(bucket.source)
        // Keep the record with more reviews (proxy for "most maintained")
        if (item.reviews_count > existing.record.reviews_count) {
          existing.record = item
        }
      }
    }
  }
  return [...byDomain.values(), ...noDomain].map(e => e.record)
}

interface FilterPersistInput {
  scraped: ScrapedBusiness[]
  query: string
  scoreMin: number
  scoreMax: number
  sources_used: Array<{ name: string; raw_count: number; status: 'ok' | 'empty' | 'skipped' }>
}

async function applyScoringFilterAndPersist(input: FilterPersistInput): Promise<{
  asOf: string
  query: string
  scrapedCount: number
  scoredAndFiltered: ScoredBusiness[]
  filter: { score_min: number; score_max: number }
  sources_used: Array<{ name: string; raw_count: number; status: 'ok' | 'empty' | 'skipped' }>
  note?: string
}> {
  // Filter junk + score
  const filtered = input.scraped
    .filter(b => b.website && !b.website.includes('facebook.com') && !b.website.includes('instagram.com'))
    .filter(b => b.reviews_count >= 10 && b.rating >= 3.8)
    .map(scoreOneGBP)
    .filter(b => b.gbp_score >= input.scoreMin && b.gbp_score <= input.scoreMax)
    .sort((a, b) => a.gbp_score - b.gbp_score)  // weakest first

  // Persist every filtered result into the master lead DB (dedupe by domain).
  // Best-effort — failures shouldn't break the search.
  await Promise.all(filtered.map(async (b) => {
    const domain = normalizeDomain(b.domain || b.website)
    if (!domain) return
    try {
      // Sources for THIS business: figure out which buckets it came from by
      // looking up which source's items it appeared in. The merge step dropped
      // that detail, so we conservatively tag with all sources that returned
      // anything — refinement later if needed.
      const sourceList = input.sources_used
        .filter(s => s.status === 'ok')
        .map(s => ({ name: s.name, discovered_at: new Date().toISOString() }))
      await upsertLead({
        domain,
        business_name: b.business_name,
        city: b.city,
        state: b.state,
        niche: b.category,
        phone: b.phone,
        website: b.website,
        gbp_url: b.gbp_url,
        gbp_score: b.gbp_score,
        category: b.category,
        rating: b.rating,
        reviews_count: b.reviews_count,
        photo_count: b.photo_count,
        sources: sourceList,
      })
      await recordInteraction(domain, {
        type: 'scrape',
        source: 'multi',
        details: { gbp_score: b.gbp_score, query: input.query, sources: sourceList.map(s => s.name) },
      })
    } catch { /* swallow */ }
  }))

  return {
    asOf: new Date().toISOString(),
    query: input.query,
    scrapedCount: input.scraped.length,
    scoredAndFiltered: filtered,
    filter: { score_min: input.scoreMin, score_max: input.scoreMax },
    sources_used: input.sources_used,
  }
}

/**
 * Parse a free-form query like "roofers in Bartow FL" into structured niche +
 * city for Yelp/BBB. If we can't parse, we return empty niche which causes
 * those sources to be skipped (Google Maps still runs).
 */
function parseQueryForSources(query: string): { niche: string; city: string } {
  // Patterns supported:
  //   "X in Y FL"    → niche=X, city=Y
  //   "X in Y"       → niche=X, city=Y
  //   "Y X"          → niche=X, city=Y (less reliable)
  const inMatch = query.match(/^(.+?)\s+in\s+(.+?)(?:\s+(?:FL|Florida))?$/i)
  if (inMatch) {
    return { niche: inMatch[1]!.trim(), city: inMatch[2]!.trim() }
  }
  return { niche: '', city: '' }
}

function normalizeApifyRecord(r: Record<string, unknown>): ScrapedBusiness {
  const website = String(r.website ?? '')
  const domain = website.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] ?? ''
  const categories = (r.additionalCategories as string[] | undefined) ?? []
  const recentImages = ((r.imageUrls as unknown[] | undefined)?.length ?? 0)
  const posts = (r.updatesFromCustomers as unknown[] | undefined) ?? []
  return {
    business_name: String(r.title ?? 'Unknown'),
    address: String(r.address ?? ''),
    city: String(r.city ?? ''),
    state: String(r.state ?? 'FL'),
    phone: String(r.phone ?? ''),
    website,
    domain,
    category: String(r.categoryName ?? ''),
    rating: Number(r.totalScore ?? 0),
    reviews_count: Number(r.reviewsCount ?? 0),
    photo_count: Number(r.imagesCount ?? recentImages ?? 0),
    categories_count: 1 + categories.length,
    has_recent_posts: posts.length > 0,
    gbp_url: String(r.url ?? ''),
    place_id: r.placeId as string | undefined,
  }
}

function scoreOneGBP(b: ScrapedBusiness): ScoredBusiness {
  const breakdown: Record<string, number> = {}
  let score = 0
  // 1. Photo count ≥25 (2 pts)
  breakdown.photos = b.photo_count >= 25 ? 2 : b.photo_count >= 10 ? 1 : 0
  score += breakdown.photos
  // 2. Reviews count ≥50 (2 pts)
  breakdown.reviews = b.reviews_count >= 50 ? 2 : b.reviews_count >= 20 ? 1 : 0
  score += breakdown.reviews
  // 3. Avg rating ≥4.5 (2 pts)
  breakdown.rating = b.rating >= 4.5 ? 2 : b.rating >= 4.0 ? 1 : 0
  score += breakdown.rating
  // 4. Has website (2 pts)
  breakdown.website = b.website ? 2 : 0
  score += breakdown.website
  // 5. Multiple categories (2 pts)
  breakdown.categories = b.categories_count >= 3 ? 2 : b.categories_count >= 2 ? 1 : 0
  score += breakdown.categories
  return { ...b, gbp_score: score, score_breakdown: breakdown }
}

// ============================================================
// 2. ENRICH_LEADS — Hunter.io + MillionVerifier in parallel
// ============================================================

export async function enrichLeads(leads: ScoredBusiness[]): Promise<{
  asOf: string
  enriched: EnrichedLead[]
  stats: { input: number; emailFound: number; verified: number; skipped: number; mode: 'paid' | 'cheap' | 'mixed' }
  costNote: string
}> {
  const hunterKey = process.env.NUXT_HUNTER_API_KEY
  const verifierKey = process.env.NUXT_MILLIONVERIFIER_API_KEY

  const enrichOne = async (lead: ScoredBusiness): Promise<EnrichedLead> => {
    if (!lead.domain) return { ...lead, enrichment_note: 'no domain' }

    // === FIND EMAIL ===
    let email: { value: string; first_name?: string; last_name?: string; position?: string } | undefined

    // Path A: Hunter (paid, ~80% hit rate, ~$0.10/lookup)
    if (hunterKey) {
      try {
        const hres = await fetch(
          `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(lead.domain)}&limit=3&type=personal&api_key=${hunterKey}`,
        )
        if (hres.ok) {
          const hdata = await hres.json() as { data?: { emails?: HunterEmail[] } }
          const best = pickBestEmail(hdata.data?.emails ?? [])
          if (best) email = { value: best.value, first_name: best.first_name, last_name: best.last_name, position: best.position }
        }
      } catch { /* fall through to cheap path */ }
    }

    // Path B (cheap fallback): Scrape the website's contact page for visible emails (~60% hit rate, FREE)
    if (!email && lead.website) {
      const found = await scrapeWebsiteForEmail(lead.website, lead.domain)
      if (found) email = { value: found }
    }

    if (!email) return { ...lead, enrichment_note: 'no email found (tried Hunter + website scrape)' }

    // === VERIFY EMAIL ===
    let verification: 'ok' | 'risky' | 'bad' | 'unknown' = 'unknown'

    // Path A: MillionVerifier (paid, ~95% accuracy, ~$0.005/check)
    if (verifierKey) {
      try {
        const vres = await fetch(
          `https://api.millionverifier.com/api/v3/?api=${verifierKey}&email=${encodeURIComponent(email.value)}&timeout=15`,
        )
        if (vres.ok) {
          const vdata = await vres.json() as { result?: string }
          const r = (vdata.result ?? 'unknown').toLowerCase()
          verification = (r === 'ok' || r === 'risky' || r === 'bad') ? r : 'unknown'
        }
      } catch { /* fall through to cheap MX check */ }
    }

    // Path B (cheap fallback): MX record check via DNS (~80% accuracy, FREE)
    if (verification === 'unknown') {
      verification = await mxCheck(lead.domain) ? 'ok' : 'bad'
    }

    return {
      ...lead,
      contact_email: email.value,
      contact_first_name: email.first_name ?? '',
      contact_last_name: email.last_name ?? '',
      contact_position: email.position ?? '',
      email_verification: verification,
    }
  }

  const results = await Promise.all(leads.map(enrichOne))
  const mode: 'paid' | 'cheap' | 'mixed' =
    hunterKey && verifierKey ? 'paid' :
    !hunterKey && !verifierKey ? 'cheap' :
    'mixed'

  // Persist enrichment back to lead DB — every email + verification update.
  await Promise.all(results.map(async (r) => {
    const domain = normalizeDomain(r.domain || r.website)
    if (!domain) return
    try {
      if (r.contact_email) {
        await upsertLead({
          domain,
          business_name: r.business_name,
          emails: [{
            value: r.contact_email,
            source: hunterKey ? 'hunter' : 'website_scrape',
            verification: r.email_verification ?? 'unknown',
            last_verified_at: new Date().toISOString(),
          }],
          ...(r.contact_first_name || r.contact_last_name ? {
            decision_maker: {
              first_name: r.contact_first_name ?? '',
              last_name: r.contact_last_name ?? '',
              ...(r.contact_position ? { title: r.contact_position } : {}),
              source: hunterKey ? 'hunter' : 'manual',
              confidence: hunterKey ? 0.7 : 0.4,
            },
          } : {}),
          status: r.email_verification === 'ok' ? 'enriched' : 'new',
        })
        await recordInteraction(domain, {
          type: 'enrich',
          source: mode,
          details: { email: r.contact_email, verification: r.email_verification },
        })
      }
    } catch { /* swallow */ }
  }))

  const stats = {
    input: leads.length,
    emailFound: results.filter(r => !!r.contact_email).length,
    verified: results.filter(r => r.email_verification === 'ok').length,
    skipped: results.filter(r => !r.contact_email).length,
    mode,
  }

  const costNote = mode === 'cheap'
    ? 'Using cheap mode: website-scrape for emails + MX-check for verification. Free. ~60% hit rate vs paid.'
    : mode === 'paid'
    ? `Using paid APIs: Hunter (~$0.10/lookup) + MillionVerifier (~$0.005/check). Cost ≈ $${(leads.length * 0.105).toFixed(2)}.`
    : 'Mixed mode — one paid, one cheap. Cost is partial.'

  return { asOf: new Date().toISOString(), enriched: results, stats, costNote }
}

// ============================================================
// CHEAP FALLBACKS
// ============================================================

async function scrapeWebsiteForEmail(websiteUrl: string, domain: string): Promise<string | null> {
  // Try the homepage first, then /contact, /contact-us, /about
  const candidates = [
    websiteUrl,
    `${websiteUrl.replace(/\/$/, '')}/contact`,
    `${websiteUrl.replace(/\/$/, '')}/contact-us`,
    `${websiteUrl.replace(/\/$/, '')}/about`,
  ]

  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Mimir-LeadGen/1.0)' },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) continue
      const html = await res.text()

      // Match mailto: links first (highest signal)
      const mailtoMatch = html.match(/mailto:([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i)
      if (mailtoMatch?.[1]) {
        const email = mailtoMatch[1].toLowerCase()
        if (isQualityEmail(email, domain)) return email
      }

      // Then visible email patterns
      const visibleMatch = html.match(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i)
      if (visibleMatch?.[1]) {
        const email = visibleMatch[1].toLowerCase()
        if (isQualityEmail(email, domain)) return email
      }
    } catch {
      // Timeout or fetch error — try next candidate
    }
  }
  return null
}

function isQualityEmail(email: string, domain: string): boolean {
  // Reject role/junk addresses
  const local = email.split('@')[0] ?? ''
  if (/^(noreply|no-reply|donotreply|webmaster|postmaster|abuse|hostmaster|root|admin)$/i.test(local)) return false
  // Prefer same-domain emails (a real contact, not a SaaS notification)
  const emailDomain = email.split('@')[1] ?? ''
  if (domain && !emailDomain.includes(domain.split('.').slice(-2, -1)[0] ?? '___')) {
    // Different domain — might still be valid (e.g., gmail for a small shop), accept with lower confidence
    return true
  }
  return true
}

// ============================================================
// SCRAPE_WEBSITE — generalized on-demand website inspector
// ============================================================
// Used by Mimir directly (tool: scrape_website) AND internally
// by enrich_leads as a Hunter fallback. Returns structured contact
// data + a text excerpt. Tries homepage + /contact, /contact-us,
// /about, /team. Caps total time to ~15s.

export interface ScrapeResult {
  asOf: string
  url: string
  ok: boolean
  status_code?: number
  pages_tried: string[]
  pages_loaded: string[]
  page_title?: string
  meta_description?: string
  emails: string[]
  phones: string[]
  social_links: Array<{ platform: string; url: string }>
  text_excerpt: string
  note?: string
}

export async function scrapeWebsite(rawUrl: string): Promise<ScrapeResult> {
  // Normalize URL
  let url = rawUrl.trim()
  if (!url) {
    return emptyScrape('', false, 'empty url')
  }
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  let parsed: URL
  try { parsed = new URL(url) } catch { return emptyScrape(rawUrl, false, 'invalid url') }
  const base = `${parsed.protocol}//${parsed.host}`
  const domain = parsed.hostname.replace(/^www\./, '')

  const candidates = [
    url,
    `${base}/contact`,
    `${base}/contact-us`,
    `${base}/about`,
    `${base}/about-us`,
    `${base}/team`,
  ]

  const emails = new Set<string>()
  const phones = new Set<string>()
  const socials = new Map<string, string>()
  let pageTitle: string | undefined
  let metaDescription: string | undefined
  let textBlob = ''
  const pagesLoaded: string[] = []
  let firstStatus: number | undefined

  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Mimir-Scraper/1.0; +https://thenordicnerd.com)',
          'Accept': 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(5000),
        redirect: 'follow',
      })
      if (firstStatus === undefined) firstStatus = res.status
      if (!res.ok) continue
      const html = await res.text()
      pagesLoaded.push(candidate)

      // Title
      if (!pageTitle) {
        const t = html.match(/<title[^>]*>([^<]+)<\/title>/i)
        if (t?.[1]) pageTitle = decodeEntities(t[1].trim()).slice(0, 200)
      }
      // Meta description
      if (!metaDescription) {
        const m = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i)
        if (m?.[1]) metaDescription = decodeEntities(m[1].trim()).slice(0, 400)
      }

      // Emails — mailto: first (high signal), then visible text
      for (const m of html.matchAll(/mailto:([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi)) {
        const email = m[1]?.toLowerCase()
        if (email && isQualityEmail(email, domain)) emails.add(email)
      }
      for (const m of html.matchAll(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi)) {
        const email = m[1]?.toLowerCase()
        if (email && isQualityEmail(email, domain)) emails.add(email)
      }

      // Phones — US formats (with or without country code)
      for (const m of html.matchAll(/\b(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/g)) {
        if (!m[1] || !m[2] || !m[3]) continue
        phones.add(`(${m[1]}) ${m[2]}-${m[3]}`)
      }

      // Social links
      for (const m of html.matchAll(/href=["'](https?:\/\/(?:www\.)?(facebook|instagram|linkedin|youtube|tiktok|x|twitter)\.com\/[^"'\s]+)["']/gi)) {
        const platform = m[2]?.toLowerCase()
        const url = m[1]
        if (platform && url && !socials.has(platform)) socials.set(platform, url)
      }

      // Text blob for excerpt (cap to avoid runaway memory)
      if (textBlob.length < 2000) {
        const stripped = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
        textBlob += ' ' + stripped
      }
    } catch {
      // Timeout or fetch error — try next candidate
    }
    if (pagesLoaded.length >= 3) break // enough — don't crawl forever
  }

  if (pagesLoaded.length === 0) {
    return {
      asOf: new Date().toISOString(),
      url,
      ok: false,
      status_code: firstStatus,
      pages_tried: candidates,
      pages_loaded: [],
      emails: [],
      phones: [],
      social_links: [],
      text_excerpt: '',
      note: firstStatus
        ? `All page fetches failed. First response: ${firstStatus}.`
        : 'All page fetches failed (timeout, DNS, or network error).',
    }
  }

  return {
    asOf: new Date().toISOString(),
    url,
    ok: true,
    status_code: firstStatus,
    pages_tried: candidates,
    pages_loaded: pagesLoaded,
    page_title: pageTitle,
    meta_description: metaDescription,
    emails: [...emails].slice(0, 10),
    phones: [...phones].slice(0, 10),
    social_links: [...socials.entries()].map(([platform, url]) => ({ platform, url })),
    text_excerpt: decodeEntities(textBlob.trim().slice(0, 1500)),
  }
}

function emptyScrape(url: string, ok: boolean, note: string): ScrapeResult {
  return {
    asOf: new Date().toISOString(),
    url,
    ok,
    pages_tried: [],
    pages_loaded: [],
    emails: [],
    phones: [],
    social_links: [],
    text_excerpt: '',
    note,
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

async function mxCheck(domain: string): Promise<boolean> {
  // Free DNS over HTTPS lookup via Cloudflare 1.1.1.1
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`, {
      headers: { 'Accept': 'application/dns-json' },
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return false
    const data = await res.json() as { Answer?: Array<{ data: string }> }
    return (data.Answer ?? []).length > 0
  } catch {
    return false
  }
}

interface HunterEmail {
  value: string
  first_name?: string
  last_name?: string
  position?: string
  confidence?: number
}

function pickBestEmail(emails: HunterEmail[]): HunterEmail | undefined {
  function score(e: HunterEmail): number {
    const p = (e.position ?? '').toLowerCase()
    if (/owner|principal|president|founder/.test(p)) return 3
    if (/manager|director/.test(p)) return 2
    if (e.first_name && e.last_name) return 1
    return 0
  }
  return [...emails].sort((a, b) => score(b) - score(a))[0]
}

// ============================================================
// 3. GENERATE_FIRST_LINES — Claude API in parallel
// ============================================================

const FIRST_LINE_SYSTEM_PROMPT = `You write the FIRST LINE of a cold email from Adam at The Nordic Nerd to a Polk County FL contractor.

INPUT: a business object (name, city, niche, category, recent photo captions, services, GBP score).

OUTPUT: ONE sentence, max 25 words, that:
1. References something specific from the input data — a service, a photo caption, the city, the niche
2. Reads like Adam wrote it personally
3. Starts lowercase (unless a proper noun)
4. Uses dry praise, not gushing

VOICE: peer-to-peer, technical, slightly nerdy. Banned: "love", "amazing", "stunning", exclamation marks, emoji.

HARD RULES:
- If input is too thin to write something genuinely personalized, output exactly "FALLBACK"
- Never invent details
- Never reference review counts or "5 stars" or any meta-data
- Use verbs like: saw, spotted, caught, stumbled on, was looking at

GOOD EXAMPLES:
- "saw your kitchen reno on Lake Eloise in the GBP photos — that quartz waterfall is clean."
- "spotted that metal roof job on 60 in your recent post — those panels look properly seamed."
- "caught a mention in your reviews about EV charger installs — that's going to be 60% of residential electrical in five years."

OUTPUT: plain text, one line, no quotes, no preamble. Just the sentence.`

export async function generateFirstLines(leads: EnrichedLead[]): Promise<{
  asOf: string
  withFirstLines: LeadWithFirstLine[]
  stats: { input: number; generated: number; fallback: number; skipped: number }
}> {
  const anthropicKey = process.env.NUXT_ANTHROPIC_API_KEY
  if (!anthropicKey) {
    return {
      asOf: new Date().toISOString(),
      withFirstLines: leads.map(l => ({ ...l, first_line: '', first_line_status: 'skipped' as const })),
      stats: { input: leads.length, generated: 0, fallback: 0, skipped: leads.length },
    }
  }
  const client = new Anthropic({ apiKey: anthropicKey })

  const genOne = async (lead: EnrichedLead): Promise<LeadWithFirstLine> => {
    if (!lead.contact_email) {
      return { ...lead, first_line: '', first_line_status: 'skipped' }
    }
    const profile = {
      business_name: lead.business_name,
      city: lead.city,
      niche: lead.category,
      category: lead.category,
      photo_count: lead.photo_count,
      reviews_count: lead.reviews_count,
      rating: lead.rating,
      has_website: !!lead.website,
      services_hint: lead.category, // limited; richer if available from Apify
    }
    try {
      const resp = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        temperature: 0.7,
        system: FIRST_LINE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify(profile) }],
      })
      const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('')
        .trim()
      if (text === 'FALLBACK' || !text) {
        return {
          ...lead,
          first_line: `Was looking at ${lead.city} contractors and ${lead.business_name} stood out.`,
          first_line_status: 'fallback',
        }
      }
      return { ...lead, first_line: text, first_line_status: 'generated' }
    } catch {
      return {
        ...lead,
        first_line: `Was looking at ${lead.city} contractors and ${lead.business_name} stood out.`,
        first_line_status: 'fallback',
      }
    }
  }

  const results = await Promise.all(leads.map(genOne))
  return {
    asOf: new Date().toISOString(),
    withFirstLines: results,
    stats: {
      input: leads.length,
      generated: results.filter(r => r.first_line_status === 'generated').length,
      fallback: results.filter(r => r.first_line_status === 'fallback').length,
      skipped: results.filter(r => r.first_line_status === 'skipped').length,
    },
  }
}

// ============================================================
// 4. PUSH_TO_INSTANTLY — push batch to a campaign
// ============================================================

interface PushInput {
  leads: LeadWithFirstLine[]
  campaign_id: string
}

export async function pushToInstantly(input: PushInput): Promise<{
  asOf: string
  pushed: number
  skipped: number
  errors: string[]
}> {
  const instantlyKey = process.env.NUXT_INSTANTLY_API_KEY
  if (!instantlyKey) {
    return {
      asOf: new Date().toISOString(),
      pushed: 0,
      skipped: input.leads.length,
      errors: ['NUXT_INSTANTLY_API_KEY not set'],
    }
  }
  if (!input.campaign_id) {
    return { asOf: new Date().toISOString(), pushed: 0, skipped: input.leads.length, errors: ['campaign_id required'] }
  }

  // Only push leads that have an email AND a first line
  const toPush = input.leads.filter(l => l.contact_email && l.first_line)
  const skipped = input.leads.length - toPush.length

  // Instantly v2: POST /api/v2/leads with campaign_id
  const errors: string[] = []
  let pushed = 0

  for (const lead of toPush) {
    try {
      const res = await fetch('https://api.instantly.ai/api/v2/leads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${instantlyKey}`,
        },
        body: JSON.stringify({
          campaign: input.campaign_id,
          email: lead.contact_email,
          first_name: lead.contact_first_name ?? '',
          last_name: lead.contact_last_name ?? '',
          company_name: lead.business_name,
          phone: lead.phone,
          website: lead.website,
          personalization: lead.first_line,
          custom_variables: {
            first_line: lead.first_line,
            city: lead.city,
            niche: lead.category,
            gbp_score: lead.gbp_score,
            gbp_url: lead.gbp_url,
          },
        }),
      })
      if (res.ok) {
        pushed++
      } else {
        errors.push(`${lead.contact_email}: ${res.status}`)
      }
    } catch (err) {
      errors.push(`${lead.contact_email}: ${err instanceof Error ? err.message : 'unknown'}`)
    }
  }

  return { asOf: new Date().toISOString(), pushed, skipped, errors: errors.slice(0, 10) }
}

// ============================================================
// 5. LIST_INSTANTLY_CAMPAIGNS — so Mimir knows the campaign_id
// ============================================================

export async function listInstantlyCampaigns(): Promise<{
  asOf: string
  campaigns: Array<{ id: string; name: string; status: string }>
  note?: string
}> {
  const instantlyKey = process.env.NUXT_INSTANTLY_API_KEY
  if (!instantlyKey) {
    return {
      asOf: new Date().toISOString(),
      campaigns: [],
      note: 'NUXT_INSTANTLY_API_KEY not set',
    }
  }

  const res = await fetch('https://api.instantly.ai/api/v2/campaigns?limit=50', {
    headers: { 'Authorization': `Bearer ${instantlyKey}` },
  })
  if (!res.ok) {
    return {
      asOf: new Date().toISOString(),
      campaigns: [],
      note: `Instantly ${res.status}`,
    }
  }
  const data = await res.json() as { items?: Array<{ id: string; name: string; status: string }> }
  return {
    asOf: new Date().toISOString(),
    campaigns: (data.items ?? []).map(c => ({ id: c.id, name: c.name, status: c.status })),
  }
}
