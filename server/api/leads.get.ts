/**
 * GET /api/leads?status=enriched&city=Lakeland&niche=roofer&min_quality=60&limit=50&offset=0&q=...
 * Lists lead records from the master DB, index-only (fast).
 */
import { listLeads, type LeadStatus } from '~/server/utils/lead-db'

export default defineEventHandler(async (event) => {
  const session = getCookie(event, 'mimir-session')
  if (!session) throw createError({ statusCode: 401, message: 'unauthorized' })

  const q = getQuery(event)
  const status = typeof q.status === 'string' ? q.status as LeadStatus : undefined
  const city = typeof q.city === 'string' && q.city ? q.city : undefined
  const niche = typeof q.niche === 'string' && q.niche ? q.niche : undefined
  const min_quality = q.min_quality ? Number(q.min_quality) : undefined
  const limit = q.limit ? Math.min(Math.max(Number(q.limit), 1), 500) : 100
  const dnc = q.dnc === 'true' ? true : q.dnc === 'false' ? false : undefined
  const search = typeof q.q === 'string' && q.q ? q.q.toLowerCase() : undefined

  // Use listLeads from lead-db (index read), then apply free-text search in memory
  const result = await listLeads({
    ...(status ? { status } : {}),
    ...(city ? { city } : {}),
    ...(niche ? { niche } : {}),
    ...(dnc !== undefined ? { dnc } : {}),
    ...(min_quality !== undefined ? { min_quality } : {}),
    limit: search ? 500 : limit,  // pull wide if filtering by search, then trim
  })

  let leads = result.leads
  if (search) {
    leads = leads.filter(l =>
      l.business_name.toLowerCase().includes(search) ||
      l.domain.toLowerCase().includes(search)
    ).slice(0, limit)
  }

  return {
    count: leads.length,
    total: result.total,
    leads,
  }
})
