import type Anthropic from '@anthropic-ai/sdk'
import { searchOpsLibrary, getOpsFile, listOpsFolder, opsSyncStatus } from './ops-context'
import {
  searchLeads,
  enrichLeads,
  generateFirstLines,
  scrapeWebsite,
  type ScoredBusiness,
  type EnrichedLead,
  type LeadWithFirstLine,
} from './lead-tools'
import { queueLead, pauseLead, getQueueStatus, type SequencedLead } from './sequence-state'
import { inboxStatus, inboxesConfigured } from './email-sender'
import {
  proposeCodeChange,
  getPrStatus,
  listOpenPrsForRepo,
  mergePr,
  githubHealthCheck,
  listManagedRepos,
} from './code-changes'
import { getPendingReplies } from './reply-ingester'

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

  // ---- LIVE BUSINESS DATA ----
  // Pipeline / money / outbound-health stubs were removed in the cull —
  // re-add only when HubSpot + Stripe + Smartlead are actually wired.
  // get_pending_replies will be added back when reply ingestion ships.

  // ---- LEAD GENERATION SUITE ----
  {
    name: 'search_leads',
    description: "Search Google Maps for contractor leads matching a query. Scrapes via Apify, computes a 0-10 GBP optimization score per business, and filters to the sweet spot (default scores 3-7 — room to improve but not too far gone). Use when Adam asks to 'find leads', 'find roofers in Lakeland', etc. Returns scored + filtered businesses with website + phone + GBP URL. Pre-launch businesses with no website are auto-excluded.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'e.g. "roofers in Bartow FL" or "kitchen remodeler Winter Haven"' },
        max_results: { type: 'number', description: 'Default 15, max 25 (larger = slower)' },
        score_min: { type: 'number', description: 'Minimum GBP score to include. Default 3.' },
        score_max: { type: 'number', description: 'Maximum GBP score. Default 7. Lower = weaker presence = better fit.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'enrich_leads',
    description: "Pass the scoredAndFiltered array from search_leads. Runs Hunter.io domain search + MillionVerifier email verification in parallel for each lead. Returns leads with contact_email, contact_first_name, contact_position, email_verification (ok/risky/bad/unknown). Use as step 2 in the lead-gen pipeline.",
    input_schema: {
      type: 'object',
      properties: {
        leads: { type: 'array', description: 'Array of ScoredBusiness from search_leads' },
      },
      required: ['leads'],
    },
  },
  {
    name: 'generate_first_lines',
    description: "Pass the enriched array from enrich_leads. Generates a personalized first-line sentence for each lead using Claude Haiku with the Nordic Nerd voice DNA. Returns leads with first_line field. Step 3 in the pipeline.",
    input_schema: {
      type: 'object',
      properties: {
        leads: { type: 'array', description: 'Array of EnrichedLead from enrich_leads' },
      },
      required: ['leads'],
    },
  },
  // Instantly tools removed in the cull — queue_sequence replaces them entirely.

  // ---- LOCAL SEQUENCE QUEUE (replaces Instantly — free, uses Gmail SMTP) ----
  {
    name: 'queue_sequence',
    description: "Queue a batch of leads for the 4-email Polk Contractor sequence. Each lead's email 1 fires the next business morning (Tue-Fri 9:30 ET) via Gmail SMTP through Adam's warmed inboxes. WRITE ACTION — REQUIRES explicit confirmation. Quote the lead count + confirm before calling.",
    input_schema: {
      type: 'object',
      properties: {
        leads: { type: 'array', description: 'Array of LeadWithFirstLine from generate_first_lines — must have email + first_name + company_name + city + niche' },
      },
      required: ['leads'],
    },
  },
  {
    name: 'get_queue_status',
    description: "Show the current sequence queue: total leads, active vs paused vs completed, due today, sent-today per inbox. Read-only. Call freely.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'pause_lead',
    description: "Pause a specific lead's sequence — use when Adam says 'Bob replied' or 'unsubscribe Sara'. Records the reason. REQUIRES confirmation if reason is unclear.",
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        reason: { type: 'string', enum: ['replied', 'unsubscribed', 'bounced', 'paused'] },
      },
      required: ['email'],
    },
  },
  {
    name: 'inbox_status',
    description: "Show which Gmail inboxes are configured + how many they've sent today vs the daily cap (30). Read-only.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_pending_replies',
    description: "Recent inbound replies pulled by the IMAP poller — sender, classification, intent, escalation flag, and the suggested draft. Use when Adam asks 'any replies', 'what's in the inbox', 'who responded'. Read-only.",
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many recent replies to return. Default 20.' },
      },
      required: [],
    },
  },
  {
    name: 'scrape_website',
    description: "Fetch a website and extract contact info: emails, phone numbers, social links, page title, meta description, and a text excerpt. Crawls homepage + /contact, /contact-us, /about, /about-us, /team (stops at first 3 successful loads). Use when Adam asks 'find an email on this site', 'what does this contractor do', 'check their site for me', or when you need contact info for a single lead outside the search/enrich pipeline. Read-only, free, ~5-15s.",
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Website URL — with or without protocol. e.g. "bartowroofing.com" or "https://example.com/contact"' },
      },
      required: ['url'],
    },
  },

  // add_deal_note, send_audit_email, trigger_weekly_scrape removed in the cull —
  // re-add when HubSpot, the audit one-pager, and the VPS n8n exist.

  // ---- CODE CHANGE PIPELINE (Mimir-as-Claude-Code) ----
  {
    name: 'list_managed_repos',
    description: "List the repos Mimir is allowed to edit (his own + the Nordic Nerd monorepo). Read-only. Call when Adam asks 'which repos can you change' or you need to know the repo key to pass to propose_code_change.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'propose_code_change',
    description: "Open a pull request that implements a code change in a managed repo. A sub-agent (Sonnet 4.6) reads the relevant files, stages edits, and Mimir atomically commits + opens the PR. Vercel auto-builds a preview deploy on the PR within 30-90s. WRITE ACTION — REQUIRES explicit confirmation from Adam BEFORE calling. Quote the repo, the instruction, and ask before proceeding. After the call returns, report the PR URL and the branch, then call get_pr_status a minute later to fetch the Vercel preview URL.",
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo key from list_managed_repos. Currently "mimir" or "nordicnerd".' },
        instruction: { type: 'string', description: 'One-paragraph instruction. The sub-agent reads it verbatim, so be specific. Good: "On pages/dashboard.vue, change the reactor color from copper to fjord when speaking=false." Bad: "make it look better."' },
      },
      required: ['repo', 'instruction'],
    },
  },
  {
    name: 'get_pr_status',
    description: "Get a PR's current state, including the Vercel preview deploy URL (scraped from the vercel[bot] comment). Use 30-90s after propose_code_change to grab the preview URL for Adam. Read-only.",
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        pr_number: { type: 'number' },
      },
      required: ['repo', 'pr_number'],
    },
  },
  {
    name: 'list_open_prs',
    description: "List open PRs in a managed repo. Use when Adam asks 'what's open', 'what PRs', or you need to find a PR number before merging. Read-only.",
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'merge_pr',
    description: "Squash-merge a PR. After merge, Vercel auto-deploys main to production. WRITE ACTION — REQUIRES explicit voice confirmation ('ship it', 'merge it', 'yes deploy'). Quote the PR title and the preview URL Adam already saw, then ask. Never merge a PR Adam hasn't acknowledged the preview of.",
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        pr_number: { type: 'number' },
      },
      required: ['repo', 'pr_number'],
    },
  },
  {
    name: 'github_health_check',
    description: "Verify the GitHub token is valid and identify the authenticated user. Read-only. Call this if any other code-change tool returns a 401 or 403.",
    input_schema: { type: 'object', properties: {}, required: [] },
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
    // ---- Lead-gen suite ----
    case 'search_leads':
      return searchLeads({
        query: String(input.query ?? ''),
        max_results: typeof input.max_results === 'number' ? input.max_results : undefined,
        score_min: typeof input.score_min === 'number' ? input.score_min : undefined,
        score_max: typeof input.score_max === 'number' ? input.score_max : undefined,
      })
    case 'enrich_leads':
      return enrichLeads((input.leads as ScoredBusiness[]) ?? [])
    case 'generate_first_lines':
      return generateFirstLines((input.leads as EnrichedLead[]) ?? [])
    case 'queue_sequence': {
      const leads = (input.leads as LeadWithFirstLine[]) ?? []
      let added = 0; let skipped = 0; const skipReasons: string[] = []
      for (const l of leads) {
        if (!l.contact_email) { skipped++; continue }
        const result = await queueLead({
          email: l.contact_email,
          first_name: l.contact_first_name ?? '',
          last_name: l.contact_last_name ?? '',
          company_name: l.business_name,
          city: l.city,
          niche: l.category,
          first_line: l.first_line ?? '',
        })
        if (result.added) added++
        else { skipped++; if (result.reason) skipReasons.push(`${l.contact_email}: ${result.reason}`) }
      }
      return { asOf: new Date().toISOString(), added, skipped, skipReasons: skipReasons.slice(0, 5), note: `Sequence starts next business morning. Check inbox_status before scaling up.` }
    }
    case 'get_queue_status':
      return await getQueueStatus()
    case 'pause_lead':
      return { ok: await pauseLead(String(input.email ?? ''), (input.reason as 'replied' | 'unsubscribed' | 'bounced' | 'paused' | undefined) ?? 'paused') }
    case 'inbox_status':
      return { configured: inboxesConfigured(), inboxes: await inboxStatus() }
    case 'get_pending_replies':
      return getPendingReplies(typeof input.limit === 'number' ? input.limit : 20)
    case 'scrape_website':
      return scrapeWebsite(String(input.url ?? ''))
    // ---- Code-change pipeline ----
    case 'list_managed_repos':
      return { repos: listManagedRepos() }
    case 'propose_code_change':
      return proposeCodeChange({
        repo: String(input.repo ?? ''),
        instruction: String(input.instruction ?? ''),
      })
    case 'get_pr_status':
      return getPrStatus(String(input.repo ?? ''), Number(input.pr_number ?? 0))
    case 'list_open_prs':
      return listOpenPrsForRepo(String(input.repo ?? ''))
    case 'merge_pr':
      return mergePr(String(input.repo ?? ''), Number(input.pr_number ?? 0))
    case 'github_health_check':
      return githubHealthCheck()
    default:
      return { error: `unknown tool: ${name}` }
  }
}

export function getOpsSyncStatus() {
  return opsSyncStatus()
}

// Stub helpers (getPipelineSummary, getMoneySummary, getPendingReplies,
// getOutboundHealth, addDealNote, sendAuditEmail, triggerWeeklyScrape) were
// removed in the cull. See git history if re-adding when the underlying
// integrations are wired (HubSpot, Stripe, IMAP, VPS n8n).
