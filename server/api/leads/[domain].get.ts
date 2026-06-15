/**
 * GET /api/leads/<domain>
 * Returns the full lead record + last 20 interactions.
 */
import { getLead, getInteractions, normalizeDomain } from '~/server/utils/lead-db'

export default defineEventHandler(async (event) => {
  const session = getCookie(event, 'mimir-session')
  if (!session) throw createError({ statusCode: 401, message: 'unauthorized' })

  const raw = getRouterParam(event, 'domain') ?? ''
  const domain = normalizeDomain(decodeURIComponent(raw))
  if (!domain) throw createError({ statusCode: 400, message: 'domain required' })

  const [lead, interactions] = await Promise.all([
    getLead(domain),
    getInteractions(domain, 20),
  ])

  if (!lead) throw createError({ statusCode: 404, message: `no record for ${domain}` })
  return { lead, interactions }
})
