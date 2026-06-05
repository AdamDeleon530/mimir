import type Anthropic from '@anthropic-ai/sdk'
import { searchOpsLibrary, getOpsFile, listOpsFolder, opsSyncStatus } from './ops-context'

// =====================================================================
// Tool DEFINITIONS — Claude sees these and decides when to call them.
// =====================================================================

export const MIMIR_TOOLS: Anthropic.Tool[] = [
  // ---- OPS LIBRARY (read everything Adam has documented) ----
  {
    name: 'search_ops_library',
    description: "Search Adam's full Nordic Nerd Operations library — sequences, agent rule files, system prompts, client templates, content calendar, daily ops checklists, infrastructure docs. ALWAYS call this BEFORE answering ANY question about agency processes, voice, pricing, deliverables, the 5 agents, sequences, GBP playbook, content workflow, or anything operational. Returns the top matching files with snippets. Query with the natural question or 2-5 keywords.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language question OR keywords (e.g. "voice DNA", "starter tier deliverables", "reply classification")' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_ops_file',
    description: 'Get the FULL content of a specific ops library file by path (e.g. "02-Agents/copywriter-agent.md"). Use after search_ops_library identifies the right file and you need more than the snippet.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Exact file path relative to the ops library root' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_ops_folder',
    description: 'List all files in a specific ops library folder (e.g. "02-Agents", "03-Outbound-System", "04-Client-Templates"). Useful when Adam asks "what\'s in X" or you need to find a file you don\'t know the exact name of.',
    input_schema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Folder name like "02-Agents" or "06-Daily-Ops"' },
      },
      required: ['folder'],
    },
  },

  // ---- LIVE BUSINESS DATA (stubs until connected) ----
  {
    name: 'get_pipeline_summary',
    description: "Live HubSpot pipeline: count + $ at each deal stage, plus deals stuck >5 days. Call when Adam asks about pipeline, deals, calls booked, proposals.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_money_summary',
    description: "Financial state: MTD revenue, MRR, target, projected months to W2-replacement at current pace. Call when Adam asks about money, revenue, MRR, or progress.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_pending_replies',
    description: "Cold-email replies waiting for Adam's review — sender, subject, classification, draft. Call when Adam asks 'what's in the queue', 'any replies', 'pending'.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_outbound_health',
    description: "Cold email deliverability: bounce rate, complaint rate, per-inbox reputation, any inboxes flagged. Call when Adam asks about deliverability, inbox health.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  // ---- WRITE actions (require confirmation in conversation) ----
  {
    name: 'add_deal_note',
    description: "Add a note to a HubSpot deal. Confirm with Adam before calling.",
    input_schema: {
      type: 'object',
      properties: {
        deal_id: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['deal_id', 'note'],
    },
  },
  {
    name: 'send_audit_email',
    description: "Send the prepared 5-things-to-fix audit one-pager to a named contact. REQUIRES explicit confirmation before calling.",
    input_schema: {
      type: 'object',
      properties: {
        contact_email: { type: 'string' },
        contact_first_name: { type: 'string' },
        company_name: { type: 'string' },
      },
      required: ['contact_email', 'contact_first_name', 'company_name'],
    },
  },
  {
    name: 'trigger_weekly_scrape',
    description: "Manually fire the Apify weekly lead-scrape workflow. REQUIRES confirmation. State expected lead count and cost first.",
    input_schema: {
      type: 'object',
      properties: {
        cities: { type: 'array', items: { type: 'string' } },
        niches: { type: 'array', items: { type: 'string' } },
      },
      required: [],
    },
  },
]

// =====================================================================
// HANDLERS
// =====================================================================

export async function executeToolCall(name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_ops_library': return searchOpsLibrary(String(input.query ?? ''))
    case 'get_ops_file':       return getOpsFile(String(input.path ?? '')) ?? { error: 'file not found' }
    case 'list_ops_folder':    return listOpsFolder(String(input.folder ?? ''))
    case 'get_pipeline_summary': return getPipelineSummary()
    case 'get_money_summary':    return getMoneySummary()
    case 'get_pending_replies':  return getPendingReplies()
    case 'get_outbound_health':  return getOutboundHealth()
    case 'add_deal_note':        return addDealNote(input)
    case 'send_audit_email':     return sendAuditEmail(input)
    case 'trigger_weekly_scrape': return triggerWeeklyScrape(input)
    default:
      return { error: `unknown tool: ${name}` }
  }
}

export function getOpsSyncStatus() {
  return opsSyncStatus()
}

// --- Live data stubs (replace with real API calls when keys are set) ---

function getPipelineSummary() {
  return {
    asOf: new Date().toISOString(),
    source: 'mock — wire NUXT_HUBSPOT_API_KEY to go live',
    stages: [
      { name: 'New Lead', count: 0, value: 0 },
      { name: 'Replied', count: 0, value: 0 },
      { name: 'Call Booked', count: 0, value: 0 },
      { name: 'Call Held', count: 0, value: 0 },
      { name: 'Proposal Sent', count: 0, value: 0 },
      { name: 'Won (MTD)', count: 0, value: 0 },
    ],
    staleDeals: [],
    note: 'Pipeline empty — pre-launch.',
  }
}

function getMoneySummary() {
  return {
    asOf: new Date().toISOString(),
    source: 'mock — wire NUXT_STRIPE_SECRET_KEY to go live',
    mtdRevenue: 0,
    mrr: 0,
    targetMrr: 0,
    monthsToTarget: null,
    burnMTD: 220,
    note: 'Zero revenue. Month one. Per plan.',
  }
}

function getPendingReplies() {
  return {
    asOf: new Date().toISOString(),
    source: 'mock — wire NUXT_INSTANTLY_API_KEY or NUXT_SMARTLEAD_API_KEY',
    pending: 0,
    recent: [],
    note: 'The queue is clean.',
  }
}

function getOutboundHealth() {
  return {
    asOf: new Date().toISOString(),
    source: 'mock — wire NUXT_INSTANTLY_API_KEY or NUXT_SMARTLEAD_API_KEY',
    bounceRate7d: 0,
    complaintRate7d: 0,
    inboxes: [],
    note: 'Inboxes not provisioned yet.',
  }
}

function addDealNote(input: Record<string, unknown>) {
  return { success: false, stub: true, note: 'add_deal_note not wired. POSTs to HubSpot when NUXT_HUBSPOT_API_KEY set.', received: input }
}

function sendAuditEmail(input: Record<string, unknown>) {
  return { success: false, stub: true, note: 'send_audit_email not wired. Gmail or Instantly send when configured.', received: input }
}

function triggerWeeklyScrape(input: Record<string, unknown>) {
  return { success: false, stub: true, note: 'trigger_weekly_scrape not wired. POSTs to n8n.thenordicnerd.com webhook once VPS deployed.', received: input }
}
