/**
 * POST /api/poll-replies
 * Polls each warmed Gmail inbox for unread replies, classifies + drafts,
 * pauses corresponding queue leads, stores results in KV.
 *
 * Called by Cowork scheduled task every 10 minutes during business hours.
 * Auth: session cookie OR X-Cron-Secret header.
 */
import { pollAllInboxes } from '~/server/utils/reply-ingester'

export default defineEventHandler(async (event) => {
  const session = getCookie(event, 'mimir-session')
  const cronSecret = getHeader(event, 'x-cron-secret')
  const expectedSecret = process.env.NUXT_CRON_SECRET
  if (!session && (!expectedSecret || cronSecret !== expectedSecret)) {
    throw createError({ statusCode: 401, message: 'unauthorized' })
  }
  const result = await pollAllInboxes()
  return result
})
