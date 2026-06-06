/**
 * POST /api/run-morning-briefing
 * Called by Cowork scheduled task each weekday at 6:30am ET.
 *
 * Auth: requires Mimir session cookie OR X-Cron-Secret header.
 */
import { generateBriefing } from '~/server/utils/briefing'

export default defineEventHandler(async (event) => {
  const session = getCookie(event, 'mimir-session')
  const cronSecret = getHeader(event, 'x-cron-secret')
  const expectedSecret = process.env.NUXT_CRON_SECRET
  if (!session && (!expectedSecret || cronSecret !== expectedSecret)) {
    throw createError({ statusCode: 401, message: 'unauthorized' })
  }

  const result = await generateBriefing()
  if (!result.ok) {
    return { ok: false, error: result.error }
  }
  return {
    ok: true,
    id: result.briefing.id,
    body: result.briefing.body,
    generated_at: result.briefing.generated_at,
    tokens_used: result.briefing.tokens_used,
  }
})
