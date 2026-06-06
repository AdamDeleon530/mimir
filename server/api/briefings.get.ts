/**
 * GET /api/briefings?limit=14
 * Returns the most recent N briefings (newest first).
 */
import { recentBriefings } from '~/server/utils/briefing'

export default defineEventHandler(async (event) => {
  const session = getCookie(event, 'mimir-session')
  if (!session) throw createError({ statusCode: 401, message: 'unauthorized' })
  const q = getQuery(event)
  const limit = Math.min(Math.max(parseInt(String(q.limit ?? '14'), 10) || 14, 1), 60)
  const briefings = await recentBriefings(limit)
  return { briefings }
})
