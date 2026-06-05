/**
 * Sequence queue — file-based state for cold email sends.
 *
 * Persists to server/data/sequences.json. Note: Vercel deploys reset filesystem state.
 * For production persistence, swap to Upstash Redis or Vercel KV (~30 min change).
 *
 * State shape:
 *   sequences: per-lead 4-email schedules, with current step + next send time
 *   sent_counts_by_inbox_day: throttling tracker, "{email}|{YYYY-MM-DD}" → count
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const STATE_FILE = join(process.cwd(), 'server', 'data', 'sequences.json')

export interface SequencedLead {
  // Identity
  email: string
  first_name: string
  last_name: string
  company_name: string
  // Merge variables
  city: string
  niche: string
  first_line: string  // not used in v1 templates (relaxed sequence is first-line-free), but stored
  // Sequence state
  current_step: 0 | 1 | 2 | 3 | 4  // 0 = queued, not yet sent
  next_send_at: string             // ISO timestamp
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

function ensureFile(): State {
  if (!existsSync(STATE_FILE)) {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    const empty: State = { sequences: [], sent_counts_by_inbox_day: {}, last_updated: new Date().toISOString() }
    writeFileSync(STATE_FILE, JSON.stringify(empty, null, 2))
    return empty
  }
  return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as State
}

function save(state: State): void {
  state.last_updated = new Date().toISOString()
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

export function readState(): State {
  return ensureFile()
}

export function queueLead(lead: Omit<SequencedLead, 'current_step' | 'next_send_at' | 'status' | 'history' | 'queued_at'>): { added: boolean; reason?: string } {
  const state = ensureFile()
  // Dedup: skip if email already in queue (any status except completed/unsubscribed allow re-queue? for now strict)
  const existing = state.sequences.find(s => s.email.toLowerCase() === lead.email.toLowerCase())
  if (existing) return { added: false, reason: `already in queue (status: ${existing.status})` }

  // Schedule email 1 for next business day at 9:30 AM ET
  const nextSend = nextBusinessMorning()
  state.sequences.push({
    ...lead,
    current_step: 0,
    next_send_at: nextSend.toISOString(),
    status: 'active',
    history: [],
    queued_at: new Date().toISOString(),
  })
  save(state)
  return { added: true }
}

export function pauseLead(email: string, reason: 'replied' | 'unsubscribed' | 'bounced' | 'paused' = 'paused'): boolean {
  const state = ensureFile()
  const lead = state.sequences.find(s => s.email.toLowerCase() === email.toLowerCase())
  if (!lead) return false
  lead.status = reason
  save(state)
  return true
}

export function findDueLeads(now = new Date()): SequencedLead[] {
  const state = ensureFile()
  return state.sequences.filter(s =>
    s.status === 'active' &&
    s.current_step < 4 &&
    new Date(s.next_send_at) <= now,
  )
}

export function recordSend(email: string, event: SendEvent, nextDelayDays: number | null): void {
  const state = ensureFile()
  const lead = state.sequences.find(s => s.email.toLowerCase() === email.toLowerCase())
  if (!lead) return

  lead.history.push(event)
  // Increment per-inbox per-day counter
  const dayKey = `${event.inbox}|${event.sent_at.slice(0, 10)}`
  state.sent_counts_by_inbox_day[dayKey] = (state.sent_counts_by_inbox_day[dayKey] ?? 0) + 1

  if (event.status === 'sent') {
    lead.current_step = (lead.current_step + 1) as 0 | 1 | 2 | 3 | 4
    if (lead.current_step >= 4) {
      lead.status = 'completed'
    } else if (nextDelayDays !== null) {
      const next = new Date()
      next.setUTCDate(next.getUTCDate() + nextDelayDays)
      // shift to next business morning
      lead.next_send_at = atBusinessMorning(next).toISOString()
    }
  }
  save(state)
}

export function inboxSentToday(inbox: string, day = new Date().toISOString().slice(0, 10)): number {
  const state = ensureFile()
  return state.sent_counts_by_inbox_day[`${inbox}|${day}`] ?? 0
}

export function getQueueStatus(): {
  total: number
  active: number
  paused: number
  completed: number
  replied: number
  due_today: number
  next_24h: number
  sent_today_by_inbox: Record<string, number>
} {
  const state = ensureFile()
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

// ============================================================
// Time helpers — keep sends to Tue-Fri 9:30am ET ish
// ============================================================

function nextBusinessMorning(): Date {
  const next = new Date()
  next.setUTCDate(next.getUTCDate() + 1)
  return atBusinessMorning(next)
}

function atBusinessMorning(d: Date): Date {
  const r = new Date(d)
  // Skip weekends — Mon = 1, Fri = 5
  while (r.getUTCDay() === 0 || r.getUTCDay() === 6 || r.getUTCDay() === 1) {
    // Skip Sundays, Saturdays, and Mondays (Tue-Fri only per ops library best practice)
    r.setUTCDate(r.getUTCDate() + 1)
  }
  // 9:30 AM ET = 13:30 UTC (EST) or 14:30 UTC (EDT). Use 14:00 UTC as a midpoint.
  r.setUTCHours(14, 0, 0, 0)
  return r
}
