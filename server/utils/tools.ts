import type Anthropic from '@anthropic-ai/sdk'

// =====================================================================
// Tool DEFINITIONS — Claude sees these and decides when to call them.
// Anthropic tool schema: https://docs.anthropic.com/en/docs/tool-use
// =====================================================================

export const MIMIR_TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_pipeline_summary',
    description: "Returns the current state of the agency's sales pipeline: count and total $ at each HubSpot deal stage, plus any deals that have been stuck >5 days in their current stage. Call this whenever Adam asks about deals, pipeline, calls booked, proposals out, or 'what's stale'.",
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_money_summary',
    description: "Returns financial state: MTD revenue, current MRR, target MRR for W2 replacement, and projected months to target at current growth pace. Call when Adam asks about revenue, MRR, money, or progress toward goal.",
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_pending_replies',
    description: "Returns the list of cold-email replies waiting for Adam's review — each with sender, subject snippet, classification (positive/question/other), and AI-drafted response. Call when Adam asks 'what's in the queue', 'any replies', 'pending', etc.",
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_outbound_health',
    description: "Returns the health of cold-email outbound: bounce rate, complaint rate, per-inbox reputation status, and any inboxes flagged for pause. Call when Adam asks about deliverability, inbox health, or 'is anything broken'.",
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_agency_context',
    description: "Returns reference info about the agency: tier definitions, deliverables per tier, the 5 internal agents' scopes, voice DNA. Call when Adam asks about offer details, agent roles, or process — or when you need to remind yourself of specifics.",
    input_schema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          enum: ['tiers', 'agents', 'voice', 'cities', 'niches', 'all'],
          description: 'Which section of agency context to return.',
        },
      },
      required: ['topic'],
    },
  },

  // ---- WRITE actions (require confirmation in conversation) ----
  {
    name: 'add_deal_note',
    description: "Add a timestamped note to a HubSpot deal. Low-risk write. Confirm with Adam before calling.",
    input_schema: {
      type: 'object',
      properties: {
        deal_id: { type: 'string', description: 'HubSpot deal ID' },
        note: { type: 'string', description: 'Plain-text note body' },
      },
      required: ['deal_id', 'note'],
    },
  },
  {
    name: 'send_audit_email',
    description: "Send the prepared 'one-pager audit' email to a named contact. REQUIRES explicit confirmation from Adam before calling — state who and which audit, ask 'Confirm?', wait for yes.",
    input_schema: {
      type: 'object',
      properties: {
        contact_email: { type: 'string', description: 'Recipient email address' },
        contact_first_name: { type: 'string' },
        company_name: { type: 'string' },
      },
      required: ['contact_email', 'contact_first_name', 'company_name'],
    },
  },
  {
    name: 'trigger_weekly_scrape',
    description: "Manually trigger the Apify weekly lead-scrape workflow. REQUIRES confirmation from Adam before calling — state estimated cost and lead volume, ask 'Confirm?', wait for yes.",
    input_schema: {
      type: 'object',
      properties: {
        cities: {
          type: 'array',
          items: { type: 'string' },
          description: 'Override default cities. Empty array = use defaults from agency context.',
        },
        niches: {
          type: 'array',
          items: { type: 'string' },
          description: 'Override default niches. Empty array = use defaults.',
        },
      },
      required: [],
    },
  },
]

// =====================================================================
// Tool HANDLERS — called from /api/chat.post.ts when Claude requests a tool.
// All return mock data in v1. TODO comments mark where to wire live APIs.
// =====================================================================

export async function executeToolCall(name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'get_pipeline_summary':       return getPipelineSummary()
    case 'get_money_summary':          return getMoneySummary()
    case 'get_pending_replies':        return getPendingReplies()
    case 'get_outbound_health':        return getOutboundHealth()
    case 'get_agency_context':         return getAgencyContext(String(input.topic ?? 'all'))
    case 'add_deal_note':              return addDealNote(input)
    case 'send_audit_email':           return sendAuditEmail(input)
    case 'trigger_weekly_scrape':      return triggerWeeklyScrape(input)
    default:
      return { error: `unknown tool: ${name}` }
  }
}

// --- READ tool implementations ---

function getPipelineSummary() {
  // TODO: replace with live HubSpot fetch when NUXT_HUBSPOT_API_KEY is set.
  // GET https://api.hubapi.com/crm/v3/objects/deals?properties=dealname,dealstage,amount,hs_lastmodifieddate
  return {
    asOf: new Date().toISOString(),
    source: 'mock — wire NUXT_HUBSPOT_API_KEY to go live',
    stages: [
      { name: 'New Lead',      count: 0, value: 0 },
      { name: 'Replied',       count: 0, value: 0 },
      { name: 'Call Booked',   count: 0, value: 0 },
      { name: 'Call Held',     count: 0, value: 0 },
      { name: 'Proposal Sent', count: 0, value: 0 },
      { name: 'Won (MTD)',     count: 0, value: 0 },
    ],
    staleDeals: [],
    note: 'Pipeline empty — month one. Outbound has not launched yet.',
  }
}

function getMoneySummary() {
  // TODO: replace with live Stripe fetch when NUXT_STRIPE_SECRET_KEY is set.
  // GET https://api.stripe.com/v1/balance + /v1/subscriptions
  return {
    asOf: new Date().toISOString(),
    source: 'mock — wire NUXT_STRIPE_SECRET_KEY to go live',
    mtdRevenue: 0,
    mrr: 0,
    targetMrr: 0, // TODO: set when Adam decides his W2 replacement number
    monthsToTarget: null,
    burnMTD: 220, // approx from tools-and-accounts.md
    note: 'Zero revenue — month one. Burn ~$220/mo per the stack inventory.',
  }
}

function getPendingReplies() {
  // TODO: replace with Smartlead/Instantly webhook log or Gmail "Cold Replies" label query.
  return {
    asOf: new Date().toISOString(),
    source: 'mock — wire NUXT_SMARTLEAD_API_KEY or Gmail label query',
    pending: 0,
    recent: [],
    note: 'No replies yet — outbound has not launched.',
  }
}

function getOutboundHealth() {
  // TODO: replace with Smartlead API GET /api/v1/email-accounts + health endpoint.
  return {
    asOf: new Date().toISOString(),
    source: 'mock — wire NUXT_SMARTLEAD_API_KEY',
    bounceRate7d: 0,
    complaintRate7d: 0,
    inboxes: [],
    note: 'Inboxes not provisioned yet — pre-DNS, pre-warmup.',
  }
}

function getAgencyContext(topic: string) {
  // This is static reference data that mirrors ~/Personal/NordicNerd-Ops/.
  const ctx: Record<string, unknown> = {
    tiers: {
      starter: { mrr: 1500, deliverables: 'Nuxt 3 site + GBP optimization + monthly reporting. 1 revision round/mo.' },
      growth:  { mrr: 2000, deliverables: 'Starter + 4 local SEO city/niche pages/mo + 2 blog posts/mo + review automation + 30-min monthly check-in.' },
      authority: { mrr: 2500, deliverables: 'Growth + 8 SEO pages/mo + 4 posts/mo + 60-min monthly strategy call + quarterly competitor audit + priority 24h SLA.' },
    },
    agents: {
      outboundOps: 'Owns scrape, deliverability, list hygiene, sequencer state.',
      copywriter:  'Owns all prospect/client copy, sequence emails, reply drafts.',
      pipeline:    'Owns reply → call → proposal → signed → first invoice.',
      clientDelivery: 'Owns site builds, GBP, content, monthly reports.',
      operations:  'Owns daily briefings, weekly rollups, monthly retros, scoreboards.',
    },
    voice: 'Peer-to-peer, technical, slightly nerdy. Lowercase opener fine. Banned: leverage, synergy, streamline, solutions (as noun), game-changer, hope this finds you well.',
    cities: ['Lakeland', 'Winter Haven', 'Bartow', 'Auburndale', 'Haines City', 'Davenport', 'Lake Wales'],
    niches: ['general_contractor', 'kitchen_bath', 'roofing', 'hvac', 'electrician', 'plumber', 'landscaper', 'pool_builder'],
  }
  if (topic === 'all') return ctx
  return { [topic]: ctx[topic] ?? null }
}

// --- WRITE tool implementations (stubbed; mark clearly) ---

function addDealNote(input: Record<string, unknown>) {
  // TODO: POST https://api.hubapi.com/crm/v4/objects/notes with deal association.
  return {
    success: false,
    stub: true,
    note: 'add_deal_note not yet wired. Will POST to HubSpot notes API once NUXT_HUBSPOT_API_KEY is set.',
    received: input,
  }
}

function sendAuditEmail(input: Record<string, unknown>) {
  // TODO: trigger Gmail or Smartlead send of the audit one-pager template.
  return {
    success: false,
    stub: true,
    note: 'send_audit_email not yet wired. Will use Gmail API or Smartlead send-as-reply once configured.',
    received: input,
  }
}

function triggerWeeklyScrape(input: Record<string, unknown>) {
  // TODO: POST to n8n webhook for workflow 01-weekly-scrape.
  return {
    success: false,
    stub: true,
    note: 'trigger_weekly_scrape not yet wired. Will POST to n8n.thenordicnerd.com webhook once VPS is deployed.',
    received: input,
  }
}
