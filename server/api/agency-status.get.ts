import { executeToolCall, getOpsSyncStatus } from '~/server/utils/tools'

/**
 * Aggregates everything the left-side JARVIS panels need into one call.
 * Lets the chat page show live status without N round-trips.
 */
export default defineEventHandler(async (event) => {
  const session = getCookie(event, 'mimir-session')
  if (!session) throw createError({ statusCode: 401, message: 'unauthorized' })

  const [money, pipeline, replies, outbound] = await Promise.all([
    executeToolCall('get_money_summary', {}),
    executeToolCall('get_pipeline_summary', {}),
    executeToolCall('get_pending_replies', {}),
    executeToolCall('get_outbound_health', {}),
  ])

  return {
    asOf: new Date().toISOString(),
    ops: getOpsSyncStatus(),
    money,
    pipeline,
    replies,
    outbound,
  }
})
