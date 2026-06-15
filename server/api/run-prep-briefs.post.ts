/**
 * POST /api/run-prep-briefs
 *
 * Cron endpoint. Generates a 1-page prep brief for every upcoming meeting
 * in the next ~24h that doesn't already have one.
 *
 * Schedule via Cowork: weekday evenings 7pm ET so the brief lands in
 * Adam's morning briefing before the next day's calls.
 */
import { generateBriefsForUpcoming } from '~/server/utils/prep-brief'

export default defineEventHandler(async (event) => {
  const session = getCookie(event, 'mimir-session')
  const cronSecret = getHeader(event, 'x-cron-secret')
  const expected = process.env.NUXT_CRON_SECRET
  if (!session && (!expected || cronSecret !== expected)) {
    throw createError({ statusCode: 401, message: 'unauthorized' })
  }
  return generateBriefsForUpcoming()
})
