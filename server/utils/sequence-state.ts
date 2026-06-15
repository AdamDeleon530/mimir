/**
 * Sequence queue — KV-backed state for cold email sends.
 *
 * Now stored in KV under a single key: mimir:queue. The old file at
 * server/data/sequences.json is no longer used — the file backend of the
 * KV abstraction writes to server/data/kv-cache.json when there's no
 * Upstash. In production (Vercel + Upstash), state survives deploys.
 *
 * Migration note: existing local sequences.json values are NOT auto-imported.
 * If you have live queued leads in the old file, run scripts/migrate-queue.ts
 * (TODO if needed) before deleting it.
 *
 * State shape (same as before):
 *   sequences: per-lead 4-email schedules, with current step + next send time
 *   sent_counts_by_inbox_day: throttling tracker, "{email}|{YYYY-MM-DD}" → count
 */
import { kv } from './kv'
import {
  blockedFromContact,
  upsertLead,
  recordInteraction,
  markDoNotContact,
  normalizeDomain,
} from './lead-db'

const QUEUE_KEY = 'mimir:queue'

// =====================================================================
// TYPES (unchanged)
// =====================================================================

export interface SequencedLead {
  // Identity
  email: string
  first_name: string
  last_name: string
  company_name: string
  // Merge variables
  city: string
  niche: string
  first_line: string
  // Sequence state
  current_step: 0 | 1 | 2 | 3 | 4
  next_send_at: string
  status: 'active' | 'paused' | 'completed' | 'replied' | 'bounced' | 'unsubscribed'
  history: SendEvent[]
  queued_at: string
}

export interface SendEvent {
  step: number
  sent_at: string
  inbox: string
  subject: string
  status: 'sent' | 'failed'
  error?: string
}

interface State {
  sequences: SequencedLead[]
  sent_counts_by_inbox_day: Record<string, number>
  last_updated: string
}

const EMPTY_STATE: State = {
  sequences: [],
  sent_counts_by_inbox_day: {},
  last_updated: new Date(0).toISOString(),
}

// =====================================================================
// KV-BACKED READ / WRITE
// =====================================================================

async function loadState(): Promise<State> {
  const stored = await kv().get<State>(QUEUE_KEY)
  if (!stored) return { ...EMPTY_STATE, last_updated: new Date(0).toISOString() }
  // Defensive shape check
  return {
    sequences: Array.isArray(stored.sequences) ? stored.sequences : [],
    sent_counts_by_inbox_day: stored.sent_counts_by_inbox_day ?? {},
    last_updated: stored.last_updated ?? new Date(0).toISOString(),
  }
}

async function saveState(state: State): Promise<void> {
  state.last_updated = new Date().toISOString()
  await kv().set(QUEUE_KEY, state)
}

export async function readState(): Promise<State> {
  return loadState()
}

// =====================================================================
// PUBLIC API
// =====================================================================

export async function queueLead(
  lead: Omit<SequencedLead, 'current_step' | 'next_send_at' | 'status' | 'history' | 'queued_at'>,
): Promise<{ added: boolean; reason?: string }> {
  const state = await loadState()

  // Hard checks BEFORE queueing — protect deliverability.
  // 1. Already queued
  const existing = state.sequences.find(s => s.email.toLowerCase() === lead.email.toLowerCase())
  if (existing) return { added: false, reason: `already in queue (status: ${existing.status})` }

  // 2. Suppression / history check via lead DB (per-domain, not per-email)
  const domain = domainFromEmail(lead.email)
  if (domain) {
    const blocked = await blockedFromContact(domain, 90)
    if (blocked) return { added: false, reason: blocked }
  }

  const nextSend = nextBusinessMorning()
  state.sequences.push({
    ...lead,
    current_step: 0,
    next_send_at: nextSend.toISOString(),
    status: 'active',
    history: [],
    queued_at: new Date().toISOString(),
  })
  await saveState(state)

  // Mirror status into lead DB so listLeads filters are accurate
  if (domain) {
    try {
      await upsertLead({
        domain,
        business_name: lead.company_name,
        city: lead.city,
        niche: lead.niche,
        status: 'queued',
      })
      await recordInteraction(domain, {
        type: 'queued',
        details: { email: lead.email, sequence: 'polk_relaxed_v1' },
      })
    } catch { /* best-effort */ }
  }
  return { added: true }
}

function domainFromEmail(email: string): string {
  return normalizeDomain((email.split('@')[1] ?? ''))
}

export async function pauseLead(
  email: string,
  reason: 'replied' | 'unsubscribed' | 'bounced' | 'paused' = 'paused',
): Promise<boolean> {
  const state = await loadState()
  const lead = state.sequences.find(s => s.email.toLowerCase() === email.toLowerCase())
  if (!lead) return false
  lead.status = reason
  await saveState(state)

  // Mirror to lead DB — replied/unsub/bounced are all DNC-worthy
  const domain = domainFromEmail(email)
  if (domain) {
    try {
      if (reason === 'replied' || reason === 'unsubscribed' || reason === 'bounced') {
        await markDoNotContact(domain, reason === 'replied' ? 'replied' : reason)
      } else {
        await recordInteraction(domain, { type: 'paused', details: { reason } })
      }
    } catch { /* best-effort */ }
  }
  return true
}

export async function findDueLeads(now = new Date()): Promise<SequencedLead[]> {
  const state = await loadState()
  return state.sequences.filter(s =>
    s.status === 'active' &&
    s.current_step < 4 &&
    new Date(s.next_send_at) <= now,
  )
}

export async function recordSend(
  email: string,
  event: SendEvent,
  nextDelayDays: number | null,
): Promise<void> {
  const state = await loadState()
  const lead = state.sequences.find(s => s.email.toLowerCase() === email.toLowerCase())
  if (!lead) return

  lead.history.push(event)
  const dayKey = `${event.inbox}|${event.sent_at.slice(0, 10)}`
  state.sent_counts_by_inbox_day[dayKey] = (state.sent_counts_by_inbox_day[dayKey] ?? 0) + 1

  if (event.status === 'sent') {
    lead.current_step = (lead.current_step + 1) as 0 | 1 | 2 | 3 | 4
    if (lead.current_step >= 4) {
      lead.status = 'completed'
    } else if (nextDelayDays !== null) {
      const next = new Date()
      next.setUTCDate(next.getUTCDate() + nextDelayDays)
      lead.next_send_at = atBusinessMorning(next).toISOString()
    }
  }
  await saveState(state)

  // Mirror to lead DB
  const domain = domainFromEmail(email)
  if (domain) {
    try {
      if (event.status === 'sent') {
        await upsertLead({
          domain,
          business_name: lead.company_name,
          status: 'contacted',
          last_contacted_at: event.sent_at,
        })
        await recordInteraction(domain, {
          type: 'email_sent',
          source: event.inbox,
          details: { step: event.step, subject: event.subject },
        })
      } else if (event.status === 'failed') {
        // Auto-suppress on hard bounce signals (transport-level errors usually
        // mean dead address — protect domain reputation).
        const err = (event.error ?? '').toLowerCase()
        const isHardBounce =
          err.includes('550') || err.includes('mailbox unavailable') ||
          err.includes('user unknown') || err.includes('no such user') ||
          err.includes('does not exist') || err.includes('recipient address rejected')
        if (isHardBounce) {
          await markDoNotContact(domain, 'bounced')
          lead.status = 'bounced'
          await saveState(state)
        }
        await recordInteraction(domain, {
          type: 'email_sent',
          source: event.inbox,
          details: { step: event.step, status: 'failed', error: event.error },
        })
      }
    } catch { /* best-effort */ }
  }
}

export async function inboxSentToday(
  inbox: string,
  day = new Date().toISOString().slice(0, 10),
): Promise<number> {
  const state = await loadState()
  return state.sent_counts_by_inbox_day[`${inbox}|${day}`] ?? 0
}

export async function getQueueStatus(): Promise<{
  total: number
  active: number
  paused: number
  completed: number
  replied: number
  due_today: number
  next_24h: number
  sent_today_by_inbox: Record<string, number>
}> {
  const state = await loadState()
  const today = new Date().toISOString().slice(0, 10)
  const now = Date.now()
  const in24h = now + 24 * 3600 * 1000

  const sent_today_by_inbox: Record<string, number> = {}
  for (const [key, count] of Object.entries(state.sent_counts_by_inbox_day)) {
    const [inbox, day] = key.split('|')
    if (day === today && inbox) sent_today_by_inbox[inbox] = count
  }

  return {
    total: state.sequences.length,
    active: state.sequences.filter(s => s.status === 'active').length,
    paused: state.sequences.filter(s => s.status === 'paused').length,
    completed: state.sequences.filter(s => s.status === 'completed').length,
    replied: state.sequences.filter(s => s.status === 'replied').length,
    due_today: state.sequences.filter(s =>
      s.status === 'active' &&
      s.current_step < 4 &&
      new Date(s.next_send_at).getTime() <= now,
    ).length,
    next_24h: state.sequences.filter(s =>
      s.status === 'active' &&
      s.current_step < 4 &&
      new Date(s.next_send_at).getTime() <= in24h,
    ).length,
    sent_today_by_inbox,
  }
}

// Bulk pause — fix for "queued the wrong batch" without N round-trips
export async function pauseBatchByDomain(domain: string, reason: 'paused' | 'unsubscribed' = 'paused'): Promise<{ paused: number }> {
  const state = await loadState()
  let paused = 0
  for (const s of state.sequences) {
    if (s.status === 'active' && s.email.toLowerCase().endsWith(`@${domain.toLowerCase()}`)) {
      s.status = reason
      paused++
    }
  }
  if (paused > 0) await saveState(state)
  return { paused }
}

// =====================================================================
// Time helpers
// =====================================================================

function nextBusinessMorning(): Date {
  const next = new Date()
  next.setUTCDate(next.getUTCDate() + 1)
  return atBusinessMorning(next)
}

function atBusinessMorning(d: Date): Date {
  const r = new Date(d)
  // Skip weekends and Mondays — Tue-Fri send window per ops library best practice
  while (r.getUTCDay() === 0 || r.getUTCDay() === 6 || r.getUTCDay() === 1) {
    r.setUTCDate(r.getUTCDate() + 1)
  }
  // 9:30 AM ET ≈ 14:00 UTC year-round midpoint
  r.setUTCHours(14, 0, 0, 0)
  return r
}
