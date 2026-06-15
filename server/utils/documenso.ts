/**
 * Documenso client (self-hosted at https://documenso.thenordicnerd.com or
 * wherever NUXT_DOCUMENSO_API_URL points). Used to send proposals from
 * pre-built templates and track signature status.
 *
 * Templates: Adam creates one template per tier in Documenso UI, then sets:
 *   NUXT_DOCUMENSO_TEMPLATE_STARTER=<template_id>
 *   NUXT_DOCUMENSO_TEMPLATE_GROWTH=<template_id>
 *   NUXT_DOCUMENSO_TEMPLATE_AUTHORITY=<template_id>
 *
 * Each template uses Documenso placeholder syntax for merge variables:
 *   {client_name}, {client_company}, {tier_price}, {start_date}, etc.
 *
 * Proposal state is mirrored in KV under mimir:proposals:<id> so we can
 * answer "what's the status of Bartow Roofing's proposal" without round-
 * tripping to Documenso every time.
 */
import { kv } from './kv'
import { getLead, normalizeDomain, upsertLead, recordInteraction } from './lead-db'

export type Tier = 'Starter' | 'Growth' | 'Authority'

const TIER_PRICE: Record<Tier, number> = {
  Starter: 1500,
  Growth: 2000,
  Authority: 2500,
}

const TIER_TEMPLATE_ENV: Record<Tier, string> = {
  Starter: 'NUXT_DOCUMENSO_TEMPLATE_STARTER',
  Growth: 'NUXT_DOCUMENSO_TEMPLATE_GROWTH',
  Authority: 'NUXT_DOCUMENSO_TEMPLATE_AUTHORITY',
}

export type ProposalStatus = 'draft' | 'sent' | 'viewed' | 'signed' | 'declined' | 'expired'

export interface Proposal {
  id: string                    // Documenso document id
  lead_domain: string
  tier: Tier
  monthly_price: number
  recipient_email: string
  recipient_name: string
  recipient_company: string
  sent_at: string
  status: ProposalStatus
  viewed_at?: string
  signed_at?: string
  declined_at?: string
  declined_reason?: string
  documenso_url?: string        // direct link Adam can hand to the prospect
  custom_terms?: string
}

const PROPOSAL_KEY = (id: string) => `mimir:proposals:${id}`
const PROPOSALS_INDEX_KEY = 'mimir:proposals:index'  // map id → { lead_domain, status, sent_at }

interface IndexEntry { id: string; lead_domain: string; tier: Tier; status: ProposalStatus; sent_at: string }
type Index = Record<string, IndexEntry>

async function loadIndex(): Promise<Index> {
  const r = await kv().get<Index>(PROPOSALS_INDEX_KEY)
  return (r && typeof r === 'object') ? r : {}
}
async function saveIndex(i: Index): Promise<void> { await kv().set(PROPOSALS_INDEX_KEY, i) }

function apiUrl(path: string): string {
  const base = (process.env.NUXT_DOCUMENSO_API_URL ?? '').replace(/\/$/, '')
  return `${base}${path}`
}

async function documensoFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = process.env.NUXT_DOCUMENSO_API_KEY
  if (!key) throw new Error('NUXT_DOCUMENSO_API_KEY not set')
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Documenso ${res.status} ${init.method ?? 'GET'} ${path} → ${text.slice(0, 300)}`)
  }
  return await res.json() as T
}

// =====================================================================
// SEND_PROPOSAL — main entry
// =====================================================================

export interface SendProposalInput {
  domain: string
  tier: Tier
  custom_terms?: string
  recipient_email_override?: string
  recipient_name_override?: string
}

export interface SendProposalResult {
  ok: boolean
  proposal?: Proposal
  note?: string
  error?: string
}

export async function sendProposal(input: SendProposalInput): Promise<SendProposalResult> {
  if (!process.env.NUXT_DOCUMENSO_API_URL || !process.env.NUXT_DOCUMENSO_API_KEY) {
    return { ok: false, error: 'Documenso not configured. Set NUXT_DOCUMENSO_API_URL + NUXT_DOCUMENSO_API_KEY in .env.' }
  }
  const tier = input.tier
  if (!(tier in TIER_PRICE)) {
    return { ok: false, error: `unknown tier ${tier}. Use Starter, Growth, or Authority.` }
  }
  const templateId = process.env[TIER_TEMPLATE_ENV[tier]]
  if (!templateId) {
    return { ok: false, error: `${TIER_TEMPLATE_ENV[tier]} not set. Create a Documenso template for ${tier} and paste its id.` }
  }

  const domain = normalizeDomain(input.domain)
  if (!domain) return { ok: false, error: 'invalid domain' }
  const lead = await getLead(domain)
  if (!lead) return { ok: false, error: `no lead record for ${domain}. Run search/enrich first.` }

  // Recipient — prefer verified email + decision-maker name
  const verifiedEmail = lead.emails.find(e => e.verification === 'ok')?.value
  const recipientEmail = input.recipient_email_override ?? verifiedEmail ?? lead.emails[0]?.value ?? ''
  if (!recipientEmail) return { ok: false, error: `no email on record for ${domain}` }
  const dm = lead.decision_maker
  const recipientName = input.recipient_name_override
    ?? (dm ? `${dm.first_name} ${dm.last_name}`.trim() : '')
    ?? lead.business_name

  // Build the template merge variables Documenso will substitute
  const mergeFields: Record<string, string> = {
    client_name: recipientName,
    client_company: lead.business_name,
    client_email: recipientEmail,
    client_city: lead.city,
    client_state: lead.state || 'FL',
    tier_name: tier,
    tier_price: `$${TIER_PRICE[tier].toLocaleString()}`,
    tier_price_numeric: String(TIER_PRICE[tier]),
    start_date: nextMonthFirst(),
    proposal_date: today(),
    ...(input.custom_terms ? { custom_terms: input.custom_terms } : {}),
  }

  // Create from template
  interface CreateResp {
    documentId: number | string
    url?: string
    signingUrl?: string
    recipients?: Array<{ email: string; signingUrl?: string }>
  }
  let created: CreateResp
  try {
    created = await documensoFetch<CreateResp>(`/api/v1/templates/${templateId}/use`, {
      method: 'POST',
      body: JSON.stringify({
        title: `Nordic Nerd — ${tier} retainer — ${lead.business_name}`,
        recipients: [{
          email: recipientEmail,
          name: recipientName,
          role: 'SIGNER',
        }],
        meta: {
          subject: `Nordic Nerd retainer agreement — ${lead.business_name}`,
          message: `${recipientName}, the agreement we discussed is attached. Same numbers as the call. Sign at your pace.`,
        },
        formValues: mergeFields,
      }),
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Documenso request failed' }
  }

  const proposalId = String(created.documentId)
  const signingUrl = created.signingUrl
    ?? created.recipients?.find(r => r.email.toLowerCase() === recipientEmail.toLowerCase())?.signingUrl
    ?? created.url

  const proposal: Proposal = {
    id: proposalId,
    lead_domain: domain,
    tier,
    monthly_price: TIER_PRICE[tier],
    recipient_email: recipientEmail,
    recipient_name: recipientName,
    recipient_company: lead.business_name,
    sent_at: new Date().toISOString(),
    status: 'sent',
    ...(signingUrl ? { documenso_url: signingUrl } : {}),
    ...(input.custom_terms ? { custom_terms: input.custom_terms } : {}),
  }

  // Persist
  await kv().set(PROPOSAL_KEY(proposalId), proposal)
  const idx = await loadIndex()
  idx[proposalId] = {
    id: proposalId,
    lead_domain: domain,
    tier,
    status: 'sent',
    sent_at: proposal.sent_at,
  }
  await saveIndex(idx)

  // Mirror to lead DB
  try {
    await upsertLead({ domain, business_name: lead.business_name })
    await recordInteraction(domain, {
      type: 'noted',
      source: 'documenso',
      details: { proposal_id: proposalId, tier, price: TIER_PRICE[tier], status: 'sent' },
    })
  } catch { /* best-effort */ }

  return { ok: true, proposal }
}

// =====================================================================
// UPDATE FROM WEBHOOK
// =====================================================================

export interface UpdateProposalInput {
  id: string
  status: ProposalStatus
  occurred_at?: string
  reason?: string
}

export async function updateProposalStatus(input: UpdateProposalInput): Promise<Proposal | null> {
  const existing = await kv().get<Proposal>(PROPOSAL_KEY(input.id))
  if (!existing) return null
  const now = input.occurred_at ?? new Date().toISOString()
  existing.status = input.status
  if (input.status === 'viewed' && !existing.viewed_at) existing.viewed_at = now
  if (input.status === 'signed') existing.signed_at = now
  if (input.status === 'declined') {
    existing.declined_at = now
    if (input.reason) existing.declined_reason = input.reason
  }
  await kv().set(PROPOSAL_KEY(input.id), existing)

  const idx = await loadIndex()
  if (idx[input.id]) {
    idx[input.id]!.status = input.status
    await saveIndex(idx)
  }

  // Lead-DB mirror
  try {
    await recordInteraction(existing.lead_domain, {
      type: 'noted',
      source: 'documenso',
      details: { proposal_id: input.id, status: input.status, reason: input.reason },
    })
  } catch { /* swallow */ }

  return existing
}

// =====================================================================
// READ
// =====================================================================

export async function getProposal(id: string): Promise<Proposal | null> {
  return kv().get<Proposal>(PROPOSAL_KEY(id))
}

export async function listProposals(filter: { status?: ProposalStatus; lead_domain?: string } = {}): Promise<Proposal[]> {
  const idx = await loadIndex()
  const ids = Object.keys(idx).filter(id => {
    const e = idx[id]!
    if (filter.status && e.status !== filter.status) return false
    if (filter.lead_domain && e.lead_domain !== normalizeDomain(filter.lead_domain)) return false
    return true
  })
  const results = await Promise.all(ids.map(id => kv().get<Proposal>(PROPOSAL_KEY(id))))
  return results.filter((p): p is Proposal => p !== null).sort((a, b) => b.sent_at.localeCompare(a.sent_at))
}

// =====================================================================
// HELPERS
// =====================================================================

function nextMonthFirst(): string {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10)
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export { TIER_PRICE }
