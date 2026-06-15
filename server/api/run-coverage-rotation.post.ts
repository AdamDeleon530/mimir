/**
 * POST /api/run-coverage-rotation
 * Runs one cell of the coverage matrix end-to-end:
 *   pick → search → license → enrich → score → would-queue (no auto-queue yet)
 *
 * Called by Cowork scheduled task weekday mornings ~10am ET. Auth: session
 * cookie OR X-Cron-Secret header.
 *
 * Optional body:
 *   {
 *     dry_run?: boolean         // skip state writes
 *     max_queue?: number         // cap for this run (default 10)
 *     quality_threshold?: number // composite minimum (default 60)
 *     cell?: { city, niche_slug } // bypass auto-pick
 *   }
 */
import { runOneCell } from '~/server/utils/coverage-matrix'

export default defineEventHandler(async (event) => {
  const session = getCookie(event, 'mimir-session')
  const cronSecret = getHeader(event, 'x-cron-secret')
  const expected = process.env.NUXT_CRON_SECRET
  if (!session && (!expected || cronSecret !== expected)) {
    throw createError({ statusCode: 401, message: 'unauthorized' })
  }

  interface CronBody {
    dry_run?: boolean
    max_queue?: number
    quality_threshold?: number
    cell?: { city: string; niche_slug: string }
  }
  const body: CronBody = await readBody<CronBody>(event).catch(() => ({} as CronBody))

  const result = await runOneCell({
    dry_run: body.dry_run ?? false,
    ...(typeof body.max_queue === 'number' ? { max_queue: body.max_queue } : {}),
    ...(typeof body.quality_threshold === 'number' ? { quality_threshold: body.quality_threshold } : {}),
    ...(body.cell ? { cell: body.cell } : {}),
  })
  return result
})
