/**
 * Yelp source via Apify.
 *
 * Yelp catches trades that don't optimize Google but DO maintain Yelp —
 * older plumbers, electricians, roofers especially. Adds ~15-25% more
 * unique contractors per cell on top of Google Maps coverage.
 *
 * Actor slug is env-configurable so Adam can swap if the actor moves.
 * Default: compass~yelp-scraper (active as of writing). Override via
 * NUXT_APIFY_YELP_ACTOR.
 *
 * Fails gracefully — returns an empty array (not throw) so a broken Yelp
 * actor doesn't take down a multi-source search.
 */
import type { ScrapedBusiness } from './lead-tools'

const DEFAULT_YELP_ACTOR = 'compass~yelp-scraper'

export interface YelpSearchInput {
  niche: string   // e.g. "roofer"
  city: string    // e.g. "Bartow"
  state?: string  // default 'FL'
  max_results?: number
}

interface YelpRawRecord {
  name?: string
  displayName?: string
  url?: string
  address?: { addressLine1?: string; city?: string; state?: string; zip?: string }
  city?: string
  state?: string
  phone?: string
  website?: string
  externalWebsiteUrl?: string
  rating?: number
  numReviews?: number
  reviewCount?: number
  categories?: Array<{ title?: string; name?: string }>
  photos?: string[]
  photoCount?: number
}

export async function searchYelp(input: YelpSearchInput): Promise<ScrapedBusiness[]> {
  const apifyToken = process.env.NUXT_APIFY_API_TOKEN
  if (!apifyToken) return []
  const actor = process.env.NUXT_APIFY_YELP_ACTOR ?? DEFAULT_YELP_ACTOR
  const state = input.state ?? 'FL'
  const location = `${input.city}, ${state}`
  const maxResults = Math.min(input.max_results ?? 15, 30)

  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${apifyToken}&timeout=180`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        searchTerms: [input.niche],
        location,
        maxItems: maxResults,
        includeReviews: false,
        includePhotos: false,
        // common alternate field names different actors use:
        searchQueries: [input.niche],
        locations: [location],
        maxBusinesses: maxResults,
      }),
    })
    if (!res.ok) {
      // Don't throw — multi-source search should survive single-source outages
      return []
    }
    const raw = await res.json() as YelpRawRecord[]
    if (!Array.isArray(raw)) return []
    return raw.map(r => toScraped(r, state)).filter(b => !!b.business_name)
  } catch {
    return []
  }
}

function toScraped(r: YelpRawRecord, defaultState: string): ScrapedBusiness {
  const name = r.displayName ?? r.name ?? ''
  const website = r.externalWebsiteUrl ?? r.website ?? ''
  const domain = website
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0] ?? ''
  const category = r.categories?.[0]?.title ?? r.categories?.[0]?.name ?? ''
  const reviewsCount = r.numReviews ?? r.reviewCount ?? 0
  return {
    business_name: name,
    address: r.address?.addressLine1 ?? '',
    city: r.address?.city ?? r.city ?? '',
    state: r.address?.state ?? r.state ?? defaultState,
    phone: r.phone ?? '',
    website,
    domain,
    category,
    rating: Number(r.rating ?? 0),
    reviews_count: Number(reviewsCount),
    photo_count: Array.isArray(r.photos) ? r.photos.length : Number(r.photoCount ?? 0),
    categories_count: r.categories?.length ?? 1,
    has_recent_posts: false,
    gbp_url: r.url ?? '',  // Yelp page URL; serves the same disambiguation role
  }
}
