/**
 * GET /api/database-stats
 * Lightweight lead-DB stats endpoint for scripts (seeder, monitoring).
 * Same shape as the database_stats Mimir tool.
 */
import { databaseStats } from '~/server/utils/lead-db'

export default defineEventHandler(async (event) => {
  const session = getCookie(event, 'mimir-session')
  const cronSecret = getHeader(event, 'x-cron-secret')
  const expected = process.env.NUXT_CRON_SECRET
  if (!session && (!expected || cronSecret !== expected)) {
    throw createError({ statusCode: 401, message: 'unauthorized' })
  }
  return databaseStats()
})
