import { executeToolCall } from '~/server/utils/tools'

interface PipelineSummary {
  stages: Array<{ name: string; count: number; value: number }>
  staleDeals: Array<{ name: string; days: number }>
}

interface MoneySummary {
  mtdRevenue: number
  mrr: number
  targetMrr: number
  monthsToTarget: number | null
}

interface RepliesSummary {
  pending: number
  recent: Array<{ from: string; subject: string }>
}

interface OutboundHealth {
  bounceRate7d: number
  complaintRate7d: number
  inboxes: Array<{ name: string; health: 'green' | 'yellow' | 'red' }>
}

export default defineEventHandler(async (event) => {
  const session = getCookie(event, 'mimir-session')
  if (!session) throw createError({ statusCode: 401, message: 'unauthorized' })

  // Fan out to all the read tools in parallel
  const [pipeline, money, replies, outbound] = await Promise.all([
    executeToolCall('get_pipeline_summary', {}) as Promise<PipelineSummary>,
    executeToolCall('get_money_summary', {}) as Promise<MoneySummary>,
    executeToolCall('get_pending_replies', {}) as Promise<RepliesSummary>,
    executeToolCall('get_outbound_health', {}) as Promise<OutboundHealth>,
  ])

  return {
    pipeline: {
      stages: pipeline.stages,
      stale: pipeline.staleDeals.map(d => ({ name: d.name, days: d.days })),
    },
    money: {
      mtd: money.mtdRevenue,
      mrr: money.mrr,
      target: money.targetMrr,
      monthsToTarget: money.monthsToTarget,
    },
    replies: {
      pending: replies.pending,
      recent: replies.recent,
    },
    outbound: {
      bounceRate: outbound.bounceRate7d,
      complaintRate: outbound.complaintRate7d,
      inboxes: outbound.inboxes,
    },
    calls: [], // TODO: wire Cal.com / Google Calendar API
    clients: [], // TODO: wire HubSpot 'customer' lifecycle stage query
  }
})
