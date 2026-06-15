/**
 * Stripe client — raw fetch wrapper (no SDK dependency).
 *
 * Stripe's REST API is simple form-encoded POST + Bearer auth, so we keep
 * the lightweight pattern the rest of Mimir uses.
 *
 * Three pieces:
 *   1. createClientFromProposal — triggered by Documenso "signed" webhook
 *   2. Money summary readers — for the dashboard + morning briefing
 *   3. Webhook helpers — used by /api/stripe/webhook
 *
 * Tier → price_id mapping comes from env (Adam creates the products in
 * the Stripe dashboard, copies the price IDs in):
 *   NUXT_STRIPE_PRICE_STARTER
 *   NUXT_STRIPE_PRICE_GROWTH
 *   NUXT_STRIPE_PRICE_AUTHORITY
 */
import { kv } from './kv'
import { getLead, upsertLead, markDoNotContact, recordInteraction, normalizeDomain } from './lead-db'
import { TIER_PRICE, type Proposal, type Tier } from './documenso'

const TIER_PRICE_ENV: Record<Tier, string> = {
  Starter: 'NUXT_STRIPE_PRICE_STARTER',
  Growth: 'NUXT_STRIPE_PRICE_GROWTH',
  Authority: 'NUXT_STRIPE_PRICE_AUTHORITY',
}

const STRIPE_BASE = 'https://api.stripe.com/v1'

export interface ClientRecord {
  lead_domain: string
  business_name: string
  tier: Tier
  monthly_price: number
  stripe_customer_id: string
  stripe_subscription_id: string
  status: 'active' | 'past_due' | 'cancelled' | 'unpaid'
  activated_at: string
  current_period_end?: string
  cancelled_at?: string
  proposal_id?: string
}

const CLIENT_KEY = (domain: string) => `mimir:clients:${normalizeDomain(domain)}`
const CLIENTS_INDEX_KEY = 'mimir:clients:index'

interface ClientIndex { [domain: string]: { tier: Tier; status: string; mrr: number; activated_at: string } }

async function loadClientIndex(): Promise<ClientIndex> {
  const i = await kv().get<ClientIndex>(CLIENTS_INDEX_KEY)
  return (i && typeof i === 'object') ? i : {}
}
async function saveClientIndex(i: ClientIndex): Promise<void> { await kv().set(CLIENTS_INDEX_KEY, i) }

// =====================================================================
// LOW-LEVEL — authenticated Stripe fetch
// =====================================================================

async function stripeFetch<T>(path: string, init: { method?: 'GET' | 'POST' | 'DELETE'; body?: Record<string, string | number | undefined> } = {}): Promise<T> {
  const key = process.env.NUXT_STRIPE_SECRET_KEY
  if (!key) throw new Error('NUXT_STRIPE_SECRET_KEY not set')
  const method = init.method ?? 'GET'

  let url = `${STRIPE_BASE}${path}`
  let body: string | undefined
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${key}`,
    'Stripe-Version': '2024-11-20.acacia',
  }

  if (init.body) {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(init.body)) {
      if (v === undefined || v === null) continue
      params.append(k, String(v))
    }
    if (method === 'GET') {
      url += `?${params.toString()}`
    } else {
      body = params.toString()
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
    }
  }

  const res = await fetch(url, { method, headers, ...(body ? { body } : {}) })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Stripe ${res.status} ${method} ${path} → ${text.slice(0, 300)}`)
  }
  return await res.json() as T
}

// =====================================================================
// CREATE CLIENT FROM PROPOSAL (called by Documenso signed webhook)
// =====================================================================

interface StripeCustomer { id: string; email: string; name: string }
interface StripeSubscription {
  id: string
  status: 'active' | 'past_due' | 'canceled' | 'unpaid' | 'trialing' | string
  current_period_end?: number
  customer: string
  items: { data: Array<{ price: { id: string; unit_amount: number } }> }
}

export async function createClientFromProposal(proposal: Proposal): Promise<ClientRecord> {
  const tier = proposal.tier
  const priceId = process.env[TIER_PRICE_ENV[tier]]
  if (!priceId) throw new Error(`${TIER_PRICE_ENV[tier]} not set. Create the ${tier} Stripe product + price first.`)

  // 1. Create (or fetch) customer by email
  const existing = await findOrCreateCustomer({
    email: proposal.recipient_email,
    name: proposal.recipient_name,
    company: proposal.recipient_company,
    lead_domain: proposal.lead_domain,
  })

  // 2. Create subscription
  const sub = await stripeFetch<StripeSubscription>('/subscriptions', {
    method: 'POST',
    body: {
      customer: existing.id,
      'items[0][price]': priceId,
      // Auto-bill on the first of each month going forward, or immediately:
      billing_cycle_anchor_config: undefined,  // immediate first invoice
      payment_behavior: 'default_incomplete',  // returns a client secret if needed
      'expand[0]': 'latest_invoice.payment_intent',
      'metadata[lead_domain]': proposal.lead_domain,
      'metadata[tier]': tier,
      'metadata[proposal_id]': proposal.id,
    },
  })

  const client: ClientRecord = {
    lead_domain: proposal.lead_domain,
    business_name: proposal.recipient_company,
    tier,
    monthly_price: TIER_PRICE[tier],
    stripe_customer_id: existing.id,
    stripe_subscription_id: sub.id,
    status: sub.status === 'active' || sub.status === 'trialing' ? 'active' : (sub.status as ClientRecord['status']),
    activated_at: new Date().toISOString(),
    ...(sub.current_period_end ? { current_period_end: new Date(sub.current_period_end * 1000).toISOString() } : {}),
    proposal_id: proposal.id,
  }
  await kv().set(CLIENT_KEY(proposal.lead_domain), client)
  const idx = await loadClientIndex()
  idx[proposal.lead_domain] = {
    tier,
    status: client.status,
    mrr: client.monthly_price,
    activated_at: client.activated_at,
  }
  await saveClientIndex(idx)

  // Mark lead as a client + suppress from future outbound (already a customer)
  try {
    const lead = await getLead(proposal.lead_domain)
    await upsertLead({
      domain: proposal.lead_domain,
      business_name: lead?.business_name ?? proposal.recipient_company,
      status: 'client',
    })
    await markDoNotContact(proposal.lead_domain, 'client')
    await recordInteraction(proposal.lead_domain, {
      type: 'noted',
      source: 'stripe',
      details: { customer_id: existing.id, subscription_id: sub.id, tier, mrr: client.monthly_price },
    })
  } catch { /* swallow */ }

  return client
}

async function findOrCreateCustomer(opts: { email: string; name: string; company: string; lead_domain: string }): Promise<StripeCustomer> {
  // Try search first (Stripe Search API)
  interface SearchResp { data: StripeCustomer[] }
  try {
    const found = await stripeFetch<SearchResp>('/customers/search', {
      method: 'GET',
      body: { query: `email:"${opts.email}"`, limit: 1 },
    })
    if (found.data[0]) return found.data[0]
  } catch { /* Search isn't enabled on every account — fall back to create */ }

  const created = await stripeFetch<StripeCustomer>('/customers', {
    method: 'POST',
    body: {
      email: opts.email,
      name: opts.name,
      description: opts.company,
      'metadata[lead_domain]': opts.lead_domain,
      'metadata[source]': 'mimir',
    },
  })
  return created
}

// =====================================================================
// MANUAL OVERRIDE — Adam triggers this when he wants to skip Documenso
// (e.g., handshake deal, custom terms)
// =====================================================================

export interface CreateClientInput {
  domain: string
  tier: Tier
  recipient_email?: string
  recipient_name?: string
}

export async function createClientManual(input: CreateClientInput): Promise<ClientRecord> {
  const domain = normalizeDomain(input.domain)
  if (!domain) throw new Error('invalid domain')
  const lead = await getLead(domain)
  if (!lead) throw new Error(`no lead record for ${domain}`)

  const email = input.recipient_email ?? lead.emails.find(e => e.verification === 'ok')?.value ?? lead.emails[0]?.value
  if (!email) throw new Error(`no email on record for ${domain}`)
  const name = input.recipient_name
    ?? (lead.decision_maker ? `${lead.decision_maker.first_name} ${lead.decision_maker.last_name}`.trim() : '')
    ?? lead.business_name

  // Build a minimal pseudo-proposal so the same activation path works
  const pseudo: Proposal = {
    id: `manual_${Date.now()}`,
    lead_domain: domain,
    tier: input.tier,
    monthly_price: TIER_PRICE[input.tier],
    recipient_email: email,
    recipient_name: name,
    recipient_company: lead.business_name,
    sent_at: new Date().toISOString(),
    status: 'signed',
    signed_at: new Date().toISOString(),
  }
  return createClientFromProposal(pseudo)
}

// =====================================================================
// READS — client list, money summary
// =====================================================================

export async function getClient(domain: string): Promise<ClientRecord | null> {
  return kv().get<ClientRecord>(CLIENT_KEY(domain))
}

export async function listClients(): Promise<ClientRecord[]> {
  const idx = await loadClientIndex()
  const results = await Promise.all(Object.keys(idx).map(d => kv().get<ClientRecord>(CLIENT_KEY(d))))
  return results.filter((c): c is ClientRecord => c !== null)
}

export interface MoneySummary {
  asOf: string
  source: 'stripe' | 'kv_index' | 'mock'
  mtd_revenue: number
  mrr: number
  active_clients: number
  past_due_clients: number
  target_mrr: number
  months_to_target: number | null
  burn_mtd: number
  note?: string
}

const TARGET_MRR = Number(process.env.NUXT_TARGET_MRR ?? '15000')   // ~Adam's W2 replacement target
const MONTHLY_BURN = Number(process.env.NUXT_MONTHLY_BURN ?? '220')

export async function getMoneySummary(): Promise<MoneySummary> {
  const clients = await listClients()
  const active = clients.filter(c => c.status === 'active')
  const pastDue = clients.filter(c => c.status === 'past_due')
  const mrr = active.reduce((sum, c) => sum + c.monthly_price, 0)

  // MTD revenue from Stripe — if not configured, fall back to MRR/30 × days elapsed
  let mtdRevenue = 0
  let source: 'stripe' | 'kv_index' | 'mock' = 'kv_index'
  if (process.env.NUXT_STRIPE_SECRET_KEY) {
    try {
      mtdRevenue = await fetchMtdRevenue()
      source = 'stripe'
    } catch {
      mtdRevenue = estimateMtdFromMrr(mrr)
      source = 'kv_index'
    }
  } else if (clients.length === 0) {
    source = 'mock'
  } else {
    mtdRevenue = estimateMtdFromMrr(mrr)
  }

  const monthsToTarget = mrr === 0 ? null : Math.ceil((TARGET_MRR - mrr) / Math.max(500, mrr / 6))

  return {
    asOf: new Date().toISOString(),
    source,
    mtd_revenue: Math.round(mtdRevenue),
    mrr,
    active_clients: active.length,
    past_due_clients: pastDue.length,
    target_mrr: TARGET_MRR,
    months_to_target: monthsToTarget,
    burn_mtd: MONTHLY_BURN,
    ...(clients.length === 0 ? { note: 'pre-launch — zero clients yet' } : {}),
  }
}

async function fetchMtdRevenue(): Promise<number> {
  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)
  const since = Math.floor(monthStart.getTime() / 1000)

  interface ChargeList {
    data: Array<{ amount: number; paid: boolean; refunded: boolean }>
    has_more: boolean
  }
  let total = 0
  let starting_after: string | undefined
  let pages = 0
  while (pages < 10) {
    const res = await stripeFetch<ChargeList & { data: Array<{ id: string; amount: number; paid: boolean; refunded: boolean }> }>('/charges', {
      method: 'GET',
      body: {
        'created[gte]': since,
        limit: 100,
        ...(starting_after ? { starting_after } : {}),
      },
    })
    for (const c of res.data) {
      if (c.paid && !c.refunded) total += c.amount  // in cents
    }
    if (!res.has_more || res.data.length === 0) break
    starting_after = res.data[res.data.length - 1]!.id
    pages++
  }
  return total / 100
}

function estimateMtdFromMrr(mrr: number): number {
  const now = new Date()
  const day = now.getUTCDate()
  const dim = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()
  return mrr * (day / dim)
}

// =====================================================================
// WEBHOOK HANDLERS (called from /api/stripe/webhook)
// =====================================================================

export async function handleStripeInvoicePaid(opts: { customerId: string; amount: number; subscriptionId?: string }): Promise<void> {
  // Find which client this customer belongs to and bump status to active
  const clients = await listClients()
  const match = clients.find(c => c.stripe_customer_id === opts.customerId)
  if (!match) return
  if (match.status !== 'active') {
    match.status = 'active'
    await kv().set(CLIENT_KEY(match.lead_domain), match)
    const idx = await loadClientIndex()
    if (idx[match.lead_domain]) {
      idx[match.lead_domain]!.status = 'active'
      await saveClientIndex(idx)
    }
  }
  await recordInteraction(match.lead_domain, {
    type: 'noted',
    source: 'stripe',
    details: { invoice_paid: opts.amount / 100, subscription_id: opts.subscriptionId },
  })
}

export async function handleStripeInvoiceFailed(opts: { customerId: string; subscriptionId?: string }): Promise<void> {
  const clients = await listClients()
  const match = clients.find(c => c.stripe_customer_id === opts.customerId)
  if (!match) return
  match.status = 'past_due'
  await kv().set(CLIENT_KEY(match.lead_domain), match)
  const idx = await loadClientIndex()
  if (idx[match.lead_domain]) {
    idx[match.lead_domain]!.status = 'past_due'
    await saveClientIndex(idx)
  }
  await recordInteraction(match.lead_domain, {
    type: 'noted',
    source: 'stripe',
    details: { invoice_failed: true, subscription_id: opts.subscriptionId },
  })
}

export async function handleStripeSubscriptionCancelled(opts: { customerId: string; subscriptionId: string }): Promise<void> {
  const clients = await listClients()
  const match = clients.find(c => c.stripe_subscription_id === opts.subscriptionId)
  if (!match) return
  match.status = 'cancelled'
  match.cancelled_at = new Date().toISOString()
  await kv().set(CLIENT_KEY(match.lead_domain), match)
  const idx = await loadClientIndex()
  if (idx[match.lead_domain]) {
    idx[match.lead_domain]!.status = 'cancelled'
    await saveClientIndex(idx)
  }
  await recordInteraction(match.lead_domain, {
    type: 'noted',
    source: 'stripe',
    details: { subscription_cancelled: opts.subscriptionId },
  })
}
