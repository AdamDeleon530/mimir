/**
 * Better Business Bureau source via Apify.
 *
 * BBB is gold for two reasons:
 *   1. The contractors registered there self-selected as "we care about
 *      reputation" — higher base quality on average.
 *   2. The BBB rating + complaint count gives a free quality signal that
 *      Google Maps doesn't have.
 *
 * Coverage: catches ~10-15% of contractors not on Google Maps, often
 * older/established shops. Less volume than Yelp but higher per-lead quality.
 *
 * Default actor: epctex~bbb-search-scraper. Override via NUXT_APIFY_BBB_ACTOR.
 */
import type { ScrapedBusiness } from './lead-tools'

const DEFAULT_BBB_ACTOR = 'epctex~bbb-search-scraper'

export interface BbbSearchInput {
  niche: string
  city: string
  state?: string
  max_results?: number
}

interface BbbRawRecord {
  businessName?: string
  name?: string
  rating?: string  // e.g. "A+", "A", "B"
  ratingNumeric?: number
  url?: string
  phone?: string
  website?: string
  address?: {
    streetAddress?: string
    addressLocality?: string
    addressRegion?: string
    postalCode?: string
  }
  city?: string
  state?: string
  numReviews?: number
  reviewsCount?: number
  yearStarted?: number
  yearStartedLocally?: number
  bbbAccredited?: boolean
  category?: string
  categories?: string[]
}

export async function searchBbb(input: BbbSearchInput): Promise<ScrapedBusiness[]> {
  const apifyToken = process.env.NUXT_APIFY_API_TOKEN
  if (!apifyToken) return []
  const actor = process.env.NUXT_APIFY_BBB_ACTOR ?? DEFAULT_BBB_ACTOR
  const state = input.state ?? 'FL'
  const maxResults = Math.min(input.max_results ?? 15, 30)

  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${apifyToken}&timeout=180`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Different BBB actors take slightly different inputs — send the common shape
        startUrls: [`https://www.bbb.org/search?find_country=USA&find_text=${encodeURIComponent(input.niche)}&find_loc=${encodeURIComponent(input.city + ', ' + state)}`],
        searchText: input.niche,
        location: `${input.city}, ${state}`,
        maxItems: maxResults,
        maxBusinesses: maxResults,
      }),
    })
    if (!res.ok) return []
    const raw = await res.json() as BbbRawRecord[]
    if (!Array.isArray(raw)) return []
    return raw.map(r => toScraped(r, state)).filter(b => !!b.business_name)
  } catch {
    return []
  }
}

function toScraped(r: BbbRawRecord, defaultState: string): ScrapedBusiness {
  const name = r.businessName ?? r.name ?? ''
  const website = r.website ?? ''
  const domain = website
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0] ?? ''

  // BBB rating is letter-grade; convert to roughly equivalent 0-5
  const numericRating = r.ratingNumeric ?? letterToRating(r.rating ?? '')

  return {
    business_name: name,
    address: r.address?.streetAddress ?? '',
    city: r.address?.addressLocality ?? r.city ?? '',
    state: r.address?.addressRegion ?? r.state ?? defaultState,
    phone: r.phone ?? '',
    website,
    domain,
    category: r.category ?? r.categories?.[0] ?? '',
    rating: numericRating,
    reviews_count: Number(r.numReviews ?? r.reviewsCount ?? 0),
    photo_count: 0,  // BBB doesn't surface photo counts
    categories_count: r.categories?.length ?? 1,
    has_recent_posts: false,
    gbp_url: r.url ?? '',
  }
}

function letterToRating(letter: string): number {
  const cleaned = letter.trim().toUpperCase()
  switch (cleaned) {
    case 'A+': return 5.0
    case 'A':  return 4.7
    case 'A-': return 4.5
    case 'B+': return 4.3
    case 'B':  return 4.0
    case 'B-': return 3.7
    case 'C+': return 3.5
    case 'C':  return 3.2
    case 'C-': return 3.0
    case 'D+': case 'D': case 'D-': return 2.5
    case 'F':  return 1.0
    default:   return 0
  }
}
