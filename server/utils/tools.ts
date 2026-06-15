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
import { verifyFloridaLicense, snapshotStatus, buildManualLicense, isKnownLicenseClass } from './dbpr'
import {
  upsertLead,
  getLead,
  listLeads,
  databaseStats,
  markDoNotContact,
  suppressionList,
  normalizeDomain,
  getInteractions,
  recomputeAllQualityScores,
} from './lead-db'
import { getCoverageMatrix, runOneCell, NICHES, POLK_CITIES } from './coverage-matrix'
import { identifyDecisionMaker } from './linkedin-enrichment'
import { checkHiringSignal } from './signal-indeed'
import { listVariants, addVariant, setVariantEnabled, abResults } from './ab-testing'
import {
  listUpcomingMeetings,
  getMeeting,
  attachLeadDomain,
  setMeetingStatus,
} from './meetings'
import {
  generateBriefForMeeting,
  getBrief,
} from './prep-brief'
import {
  sendProposal,
  getProposal,
  listProposals,
  TIER_PRICE,
} from './documenso'
import {
  createClientManual,
  getClient,
  listClients,
  getMoneySummary,
} from './stripe-client'

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
  {
    name: 'verify_license',
    description: "Verify a Florida contractor's DBPR license. Pass business_name + city (optional but recommended). Returns license number, class (CGC/CBC/CRC/CCC/CMC/CFC/CAC/CPC/EC), status (active/expired/suspended/revoked), tenure in years, and discipline history. The result is auto-attached to the lead DB record. Step between search_leads and enrich_leads — unlicensed contractors should be filtered out before spending Hunter credits on them. Read-only.",
    input_schema: {
      type: 'object',
      properties: {
        business_name: { type: 'string' },
        city: { type: 'string', description: 'Helps disambiguate when multiple businesses share a name.' },
        license_number: { type: 'string', description: 'Shortcut if Adam already has it. Otherwise leave blank.' },
        domain: { type: 'string', description: 'Optional — used so the result attaches to the right lead DB record.' },
      },
      required: [],
    },
  },
  {
    name: 'dbpr_snapshot_status',
    description: "Report when the local DBPR license snapshot was last refreshed and how many contractor records it holds. Use when verify_license returns 'no snapshot loaded' or Adam asks 'is the DBPR data fresh'. Read-only.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'attach_license',
    description: "Manually attach a Florida DBPR license to a lead. Use when verify_license can't find one (empty snapshot, business name mismatch) but Adam has the license number from the contractor's GBP, truck wrap, business card, or website footer. Validates the license-class prefix and tenure. Write tool but protective + factual — no confirmation needed.",
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Lead domain (or website URL — normalized automatically)' },
        license_number: { type: 'string', description: 'e.g. CGC1521234 or EC0001234. The prefix determines the class.' },
        status: { type: 'string', enum: ['active', 'expired', 'suspended', 'revoked', 'voluntarily_relinquished', 'unknown'], description: 'Default "active" if Adam confirms the contractor is currently working.' },
        issue_date: { type: 'string', description: 'YYYY-MM-DD if known.' },
        expiration_date: { type: 'string' },
      },
      required: ['domain', 'license_number'],
    },
  },

  // ---- LEAD DATABASE + SUPPRESSION ----
  {
    name: 'list_leads_db',
    description: "List leads from the master database (KV-backed, dedupe by domain). Filterable by status, city, niche, dnc, and minimum quality score. Read-only. Use when Adam asks 'how many contractors do we know about', 'show me Bartow roofers in the database', 'which leads are queued', etc.",
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'new | enriched | queued | contacted | replied_positive | replied_question | replied_objection | replied_ooo | unsubscribed | bounced | client | rejected | do_not_contact' },
        city: { type: 'string' },
        niche: { type: 'string' },
        dnc: { type: 'boolean' },
        min_quality: { type: 'number' },
        limit: { type: 'number', description: 'Default 50' },
      },
      required: [],
    },
  },
  {
    name: 'get_lead',
    description: "Get the full master record for a single contractor by domain (or website URL). Includes contact info, license, signals, interaction history. Read-only.",
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'e.g. "bartowroofing.com" or a full URL — normalized automatically.' },
        include_interactions: { type: 'boolean', description: 'Default true — appends the last 20 events.' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'database_stats',
    description: "High-level stats on the lead database: total count, breakdown by status / city / niche, suppressed count. Use for morning-briefing-style overviews. Read-only.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'mark_do_not_contact',
    description: "Add a domain to the suppression list — Mimir will refuse to queue or send to any email at that domain. Protective action — no confirmation required. Reasons: 'unsubscribed', 'bounced', 'negative', 'replied', 'client', 'manual'. Use when Adam says 'never email Bartow Roofing again' or when you spot a reason yourself.",
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        reason: { type: 'string', enum: ['unsubscribed', 'bounced', 'negative', 'replied', 'client', 'manual'] },
      },
      required: ['domain', 'reason'],
    },
  },
  {
    name: 'suppression_list',
    description: "List every domain currently on the do-not-contact list. Read-only. Use when Adam asks 'who's blocked' or 'show me the DNC list'.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  // ---- COVERAGE MATRIX (autonomous prospecting grid) ----
  {
    name: 'coverage_status',
    description: "Returns the full 56-cell coverage matrix (7 Polk cities × 8 niches). Each cell shows last-scraped, scraped/contacted counts, saturation %, and status (fresh/maintenance/saturated). Use when Adam asks 'what cells are stale', 'which markets have we hit', 'coverage report'. Read-only.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'run_coverage_cell',
    description: "Manually run one cell of the coverage matrix end-to-end: search → license verify → enrich → score → would-queue (gated by quality threshold). Use when Adam says 'run Bartow roofers' or 'hit Lakeland plumbers'. Defaults pick the most-overdue eligible cell if no parameters given. WRITE — REQUIRES confirmation only if Adam didn't specify the cell. If he did, run without confirmation since it's just one cell of work he asked for.",
    input_schema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'One of: Lakeland, Winter Haven, Bartow, Auburndale, Haines City, Davenport, Lake Wales' },
        niche_slug: { type: 'string', description: 'One of: general-contractor, kitchen-remodeler, roofer, hvac-contractor, electrician, plumber, landscaper, pool-builder' },
        dry_run: { type: 'boolean', description: 'If true, run the pipeline but skip state writes. Default false.' },
        max_queue: { type: 'number', description: 'Hard cap on auto-queue count. Default 10.' },
        quality_threshold: { type: 'number', description: 'Composite quality score required for auto-queue. Default 60.' },
      },
      required: [],
    },
  },
  {
    name: 'recompute_quality_scores',
    description: "Recompute the composite quality score (V2) for every lead in the master DB. Use after the scoring formula changes or to backfill records saved before the score existed. Returns distribution buckets + top 5. Read-only-ish (mutates index but no external sends).",
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  // ---- DECISION-MAKER + INTENT SIGNAL ENRICHMENT ----
  {
    name: 'identify_decision_maker',
    description: "Find the owner / president / founder of a contractor business on LinkedIn and attach their name + title + LinkedIn URL to the lead. Costs ~$0.05 per lookup via Apify. Use after enrich_leads finds a verified email — the decision-maker info pushes the quality score up by 10-20 points. Read-only (writes to lead DB). Call without confirmation.",
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Lead domain (e.g. "bartowroofing.com")' },
        business_name: { type: 'string', description: 'Optional override — defaults to whatever is in the lead DB.' },
        city: { type: 'string', description: 'Optional override.' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'check_hiring_signal',
    description: "Check Indeed for active job posts at a contractor business. Hiring = active growth = budget for marketing. A hiring signal adds 6 points to the lead's intent score. Use on high-quality leads that haven't been contacted yet. Read-only (writes signals to lead DB).",
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        business_name: { type: 'string', description: 'Optional override.' },
        city: { type: 'string' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'attach_signal',
    description: "Manually attach an intent signal to a lead — used when Adam spots something the auto-checkers miss (recent permit, news mention, sign in front of new project, etc.). Bumps the intent component of the composite quality score. Protective + factual — no confirmation needed.",
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        kind: { type: 'string', enum: ['permits_30d', 'hiring', 'recent_gbp_post', 'recent_review'], description: 'Which signal to set.' },
        count: { type: 'number', description: 'For permits_30d / hiring — number observed. Defaults to 1.' },
        date: { type: 'string', description: 'For recent_gbp_post / recent_review — ISO date when observed.' },
      },
      required: ['domain', 'kind'],
    },
  },

  // ---- A/B TESTING ----
  {
    name: 'list_ab_variants',
    description: "List the current subject-line variant pool. Each variant has step (1-4), subject text, enabled flag. Read-only.",
    input_schema: {
      type: 'object',
      properties: {
        step: { type: 'number', description: 'Filter to a single step (1, 2, 3, or 4). Omit for all steps.' },
      },
      required: [],
    },
  },
  {
    name: 'add_ab_variant',
    description: "Add a new subject-line variant to test. New variants start enabled and get picked at ~50% rate until performance data accumulates. Use when Adam says 'try this subject: ...'. No confirmation needed — adding a variant is reversible.",
    input_schema: {
      type: 'object',
      properties: {
        step: { type: 'number', description: 'Which email step the variant applies to (1-4).' },
        subject: { type: 'string', description: 'Subject template. Supports merge variables: {{first_name}}, {{company_name}}, {{city}}, {{niche}}.' },
        description: { type: 'string', description: 'Short note explaining the angle (e.g. "curiosity opener").' },
      },
      required: ['step', 'subject'],
    },
  },
  {
    name: 'set_ab_variant_enabled',
    description: "Enable or disable a subject-line variant by ID. Use to retire underperformers or pause a test. No confirmation needed.",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      required: ['id', 'enabled'],
    },
  },
  {
    name: 'ab_results',
    description: "Report per-variant performance: sends, replies, positive replies, reply rate, positive rate. Filter by city/niche to see per-cell winners. Sorted best positive-rate first. Read-only.",
    input_schema: {
      type: 'object',
      properties: {
        city: { type: 'string' },
        niche: { type: 'string' },
      },
      required: [],
    },
  },

  // ---- MEETINGS (Cal.com bookings) ----
  {
    name: 'list_upcoming_meetings',
    description: "Calls Adam has booked. Read-only. Use when Adam asks 'what's on the calendar', 'what calls today', 'when is the next call'. Returns sorted by start time.",
    input_schema: {
      type: 'object',
      properties: {
        within_hours: { type: 'number', description: 'Optional horizon in hours. Default = no limit.' },
        include_cancelled: { type: 'boolean', description: 'Default false.' },
      },
      required: [],
    },
  },
  {
    name: 'get_meeting',
    description: "Get one meeting's full details by booking id. Read-only.",
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'attach_meeting_lead',
    description: "Manually link a meeting to a lead DB record when the email-to-domain match didn't catch it (e.g., prospect booked using a personal Gmail). Write — no confirmation, factual data entry.",
    input_schema: {
      type: 'object',
      properties: {
        meeting_id: { type: 'string' },
        domain: { type: 'string' },
      },
      required: ['meeting_id', 'domain'],
    },
  },
  {
    name: 'mark_meeting_completed',
    description: "Mark a meeting as completed (after the call wraps). Cal.com fires MEETING_ENDED automatically but this lets Adam mark manually if needed. Write — no confirmation.",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        no_show: { type: 'boolean', description: 'If true, mark as no_show instead of completed.' },
      },
      required: ['id'],
    },
  },

  // ---- PREP BRIEFS ----
  {
    name: 'generate_prep_brief',
    description: "Manually generate (or regenerate) the pre-call brief for a specific meeting. Uses Claude with full lead context — GBP, license, signals, live website scrape. Takes 30-60 seconds. The brief lands in KV + the morning briefing. Usually runs automatically 7pm the night before via cron; this is for ad-hoc.",
    input_schema: {
      type: 'object',
      properties: { meeting_id: { type: 'string' } },
      required: ['meeting_id'],
    },
  },
  {
    name: 'get_prep_brief',
    description: "Read the pre-call brief for a meeting. Returns the body (one paragraph), three concrete weaknesses to lead with, suggested tier, and three talking points. Read-only.",
    input_schema: {
      type: 'object',
      properties: { meeting_id: { type: 'string' } },
      required: ['meeting_id'],
    },
  },

  // ---- PROPOSALS (Documenso) ----
  {
    name: 'send_proposal',
    description: "Send a retainer proposal to a lead via Documenso. The tier ('Starter' $1.5K, 'Growth' $2K, 'Authority' $2.5K) selects which template fills + sends. WRITE — REQUIRES explicit confirmation. Quote the lead, tier, price, and recipient email back, then ask.",
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Lead domain' },
        tier: { type: 'string', enum: ['Starter', 'Growth', 'Authority'] },
        custom_terms: { type: 'string', description: 'Optional custom terms paragraph to inject into the template.' },
        recipient_email_override: { type: 'string', description: 'Override the auto-picked recipient email.' },
        recipient_name_override: { type: 'string' },
      },
      required: ['domain', 'tier'],
    },
  },
  {
    name: 'list_proposals',
    description: "List proposals. Filter by status (draft, sent, viewed, signed, declined, expired) or lead_domain. Read-only.",
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        lead_domain: { type: 'string' },
      },
      required: [],
    },
  },
  {
    name: 'get_proposal',
    description: "Get one proposal's full details by id. Read-only.",
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },

  // ---- CLIENTS (Stripe customers + subscriptions) ----
  {
    name: 'create_client_manual',
    description: "Create a Stripe customer + subscription for a lead without going through Documenso. Use for handshake deals or when Documenso isn't wired. WRITE — REQUIRES explicit confirmation. Quote the lead, tier, monthly price.",
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        tier: { type: 'string', enum: ['Starter', 'Growth', 'Authority'] },
        recipient_email: { type: 'string' },
        recipient_name: { type: 'string' },
      },
      required: ['domain', 'tier'],
    },
  },
  {
    name: 'list_clients',
    description: "List active + past-due + cancelled clients with their tier, MRR contribution, status, activation date. Read-only.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_client',
    description: "Get one client's full record by domain. Includes Stripe IDs, status, current period end. Read-only.",
    input_schema: {
      type: 'object',
      properties: { domain: { type: 'string' } },
      required: ['domain'],
    },
  },
  {
    name: 'get_money_summary',
    description: "MTD revenue, MRR, active clients count, past-due count, target MRR, projected months to W2-replacement. Pulls real numbers from Stripe + KV client index. Read-only. Use when Adam asks about money, revenue, progress, runway.",
    input_schema: { type: 'object', properties: {}, required: [] },
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
    case 'verify_license': {
      const result = await verifyFloridaLicense({
        business_name: typeof input.business_name === 'string' ? input.business_name : undefined,
        city: typeof input.city === 'string' ? input.city : undefined,
        license_number: typeof input.license_number === 'string' ? input.license_number : undefined,
        domain: typeof input.domain === 'string' ? input.domain : undefined,
      })
      // Persist back to the lead DB if we matched + have a domain
      if (result.matched && result.license && typeof input.domain === 'string') {
        try {
          const d = normalizeDomain(input.domain)
          if (d) {
            const existing = await getLead(d)
            await upsertLead({
              domain: d,
              business_name: existing?.business_name ?? (typeof input.business_name === 'string' ? input.business_name : d),
              license: result.license,
            })
          }
        } catch { /* best-effort */ }
      }
      return result
    }
    case 'dbpr_snapshot_status':
      return snapshotStatus()
    case 'attach_license': {
      const domain = normalizeDomain(String(input.domain ?? ''))
      const licenseNumber = String(input.license_number ?? '').trim()
      if (!domain || !licenseNumber) {
        return { ok: false, error: 'domain and license_number required' }
      }
      const license = buildManualLicense({
        license_number: licenseNumber,
        status: typeof input.status === 'string' ? input.status as never : 'active',
        issue_date: typeof input.issue_date === 'string' ? input.issue_date : undefined,
        expiration_date: typeof input.expiration_date === 'string' ? input.expiration_date : undefined,
      })
      const classKnown = isKnownLicenseClass(license.class)
      try {
        const existing = await getLead(domain)
        await upsertLead({
          domain,
          business_name: existing?.business_name ?? domain,
          license,
        })
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'persist failed' }
      }
      return {
        ok: true,
        domain,
        license,
        class_recognized: classKnown,
        note: classKnown
          ? `Attached ${license.class} ${license.number} to ${domain}.`
          : `Attached ${license.number}, but class "${license.class}" isn't a recognized FL construction prefix (expected CGC/CBC/CRC/CCC/CMC/CFC/CAC/CPC/EC). Double-check the license number.`,
      }
    }
    case 'list_leads_db':
      return listLeads({
        status: typeof input.status === 'string' ? input.status as never : undefined,
        city: typeof input.city === 'string' ? input.city : undefined,
        niche: typeof input.niche === 'string' ? input.niche : undefined,
        dnc: typeof input.dnc === 'boolean' ? input.dnc : undefined,
        min_quality: typeof input.min_quality === 'number' ? input.min_quality : undefined,
        limit: typeof input.limit === 'number' ? input.limit : 50,
      })
    case 'get_lead': {
      const domain = String(input.domain ?? '')
      const lead = await getLead(domain)
      if (!lead) return { ok: false, error: `no record for ${domain}` }
      const includeInteractions = input.include_interactions !== false
      const interactions = includeInteractions ? await getInteractions(domain, 20) : undefined
      return { ok: true, lead, interactions }
    }
    case 'database_stats':
      return databaseStats()
    case 'mark_do_not_contact': {
      const domain = String(input.domain ?? '')
      const reason = String(input.reason ?? 'manual') as 'unsubscribed' | 'bounced' | 'negative' | 'replied' | 'client' | 'manual'
      const ok = await markDoNotContact(domain, reason)
      return { ok, domain: normalizeDomain(domain), reason }
    }
    case 'suppression_list':
      return suppressionList()
    case 'coverage_status':
      return getCoverageMatrix()
    case 'run_coverage_cell': {
      const city = typeof input.city === 'string' ? input.city : undefined
      const niche_slug = typeof input.niche_slug === 'string' ? input.niche_slug : undefined
      const cell = city && niche_slug ? { city, niche_slug } : undefined
      return runOneCell({
        ...(cell ? { cell } : {}),
        ...(typeof input.dry_run === 'boolean' ? { dry_run: input.dry_run } : {}),
        ...(typeof input.max_queue === 'number' ? { max_queue: input.max_queue } : {}),
        ...(typeof input.quality_threshold === 'number' ? { quality_threshold: input.quality_threshold } : {}),
      })
    }
    case 'recompute_quality_scores':
      return recomputeAllQualityScores()
    case 'identify_decision_maker':
      return identifyDecisionMaker({
        domain: String(input.domain ?? ''),
        ...(typeof input.business_name === 'string' ? { business_name: input.business_name } : {}),
        ...(typeof input.city === 'string' ? { city: input.city } : {}),
      })
    case 'check_hiring_signal':
      return checkHiringSignal({
        domain: String(input.domain ?? ''),
        ...(typeof input.business_name === 'string' ? { business_name: input.business_name } : {}),
        ...(typeof input.city === 'string' ? { city: input.city } : {}),
      })
    case 'attach_signal': {
      const domain = normalizeDomain(String(input.domain ?? ''))
      const kind = String(input.kind ?? '') as 'permits_30d' | 'hiring' | 'recent_gbp_post' | 'recent_review'
      if (!domain) return { ok: false, error: 'domain required' }
      const existing = await getLead(domain)
      if (!existing) return { ok: false, error: `no lead record for ${domain}` }
      const signals = { ...(existing.signals ?? {}) }
      const now = new Date().toISOString()
      const count = typeof input.count === 'number' ? input.count : 1
      const date = typeof input.date === 'string' ? input.date : now
      if (kind === 'hiring')              signals.hiring = { count, sources: ['manual'], checked_at: now }
      else if (kind === 'permits_30d')    signals.permits_30d = { count, checked_at: now }
      else if (kind === 'recent_gbp_post') signals.last_gbp_post_at = date
      else if (kind === 'recent_review')   signals.last_review_at = date
      else return { ok: false, error: `unknown signal kind ${kind}` }
      await upsertLead({ domain, business_name: existing.business_name, signals })
      return { ok: true, domain, kind, signals }
    }
    case 'list_ab_variants':
      return { variants: await listVariants(typeof input.step === 'number' ? input.step : undefined) }
    case 'add_ab_variant': {
      const v = await addVariant({
        step: Number(input.step ?? 1),
        subject: String(input.subject ?? ''),
        ...(typeof input.description === 'string' ? { description: input.description } : {}),
      })
      return { ok: true, variant: v }
    }
    case 'set_ab_variant_enabled': {
      const ok = await setVariantEnabled(String(input.id ?? ''), Boolean(input.enabled))
      return { ok }
    }
    case 'ab_results':
      return {
        rows: await abResults({
          ...(typeof input.city === 'string' ? { city: input.city } : {}),
          ...(typeof input.niche === 'string' ? { niche: input.niche } : {}),
        }),
      }

    // ---- MEETINGS ----
    case 'list_upcoming_meetings':
      return {
        meetings: await listUpcomingMeetings({
          ...(typeof input.within_hours === 'number' ? { within_hours: input.within_hours } : {}),
          ...(typeof input.include_cancelled === 'boolean' ? { include_cancelled: input.include_cancelled } : {}),
        }),
      }
    case 'get_meeting': {
      const id = String(input.id ?? '')
      const m = await getMeeting(id)
      if (!m) return { ok: false, error: `no meeting ${id}` }
      return { ok: true, meeting: m }
    }
    case 'attach_meeting_lead': {
      const ok = await attachLeadDomain(String(input.meeting_id ?? ''), String(input.domain ?? ''))
      return { ok }
    }
    case 'mark_meeting_completed': {
      const id = String(input.id ?? '')
      const status = input.no_show ? 'no_show' : 'completed'
      const m = await setMeetingStatus(id, status)
      return { ok: !!m, meeting: m }
    }

    // ---- PREP BRIEFS ----
    case 'generate_prep_brief': {
      const id = String(input.meeting_id ?? '')
      const m = await getMeeting(id)
      if (!m) return { ok: false, error: `no meeting ${id}` }
      return generateBriefForMeeting(m)
    }
    case 'get_prep_brief': {
      const id = String(input.meeting_id ?? '')
      const brief = await getBrief(id)
      if (!brief) return { ok: false, error: `no brief for meeting ${id}. Run generate_prep_brief first.` }
      return { ok: true, brief }
    }

    // ---- PROPOSALS ----
    case 'send_proposal':
      return sendProposal({
        domain: String(input.domain ?? ''),
        tier: String(input.tier ?? 'Starter') as 'Starter' | 'Growth' | 'Authority',
        ...(typeof input.custom_terms === 'string' ? { custom_terms: input.custom_terms } : {}),
        ...(typeof input.recipient_email_override === 'string' ? { recipient_email_override: input.recipient_email_override } : {}),
        ...(typeof input.recipient_name_override === 'string' ? { recipient_name_override: input.recipient_name_override } : {}),
      })
    case 'list_proposals':
      return {
        proposals: await listProposals({
          ...(typeof input.status === 'string' ? { status: input.status as 'draft' | 'sent' | 'viewed' | 'signed' | 'declined' | 'expired' } : {}),
          ...(typeof input.lead_domain === 'string' ? { lead_domain: input.lead_domain } : {}),
        }),
      }
    case 'get_proposal': {
      const id = String(input.id ?? '')
      const p = await getProposal(id)
      if (!p) return { ok: false, error: `no proposal ${id}` }
      return { ok: true, proposal: p }
    }

    // ---- CLIENTS ----
    case 'create_client_manual': {
      try {
        const client = await createClientManual({
          domain: String(input.domain ?? ''),
          tier: String(input.tier ?? 'Starter') as 'Starter' | 'Growth' | 'Authority',
          ...(typeof input.recipient_email === 'string' ? { recipient_email: input.recipient_email } : {}),
          ...(typeof input.recipient_name === 'string' ? { recipient_name: input.recipient_name } : {}),
        })
        return { ok: true, client }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'create failed' }
      }
    }
    case 'list_clients':
      return { clients: await listClients() }
    case 'get_client': {
      const c = await getClient(String(input.domain ?? ''))
      if (!c) return { ok: false, error: `no client for that domain` }
      return { ok: true, client: c }
    }
    case 'get_money_summary':
      return getMoneySummary()

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
    case 'get_money_summary':
      return { mtdRevenue: null, mrr: null, burnMTD: null, note: 'not yet connected' }
    case 'get_pipeline_summary':
      return { stages: [], note: 'not yet connected' }
    case 'get_outbound_health':
      return { bounceRate7d: null, complaintRate7d: null, inboxes: [], note: 'not yet connected' }
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
