/**
 * Meetings — Cal.com bookings + their lifecycle.
 *
 * Stored in KV as a list at mimir:meetings (most recent first when read).
 * Each record carries everything we need to find it later: cal booking id,
 * attendee email (the human Adam will talk to), lead_domain (when we can
 * match the attendee to an existing lead in the DB), title, time window,
 * status, and prep_brief_id (set when the pre-call brief generator runs).
 *
 * Reads scale fine to ~hundreds of meetings; if it grows we'll shard by month.
 */
import { kv } from './kv'
import { upsertLead, getLead, normalizeDomain, recordInteraction } from './lead-db'

const MEETINGS_KEY = 'mimir:meetings'
const MAX_MEETINGS_KEPT = 500

export type MeetingStatus = 'booked' | 'cancelled' | 'rescheduled' | 'completed' | 'no_show'

export interface Meeting {
  id: string                    // cal.com booking id or our generated id
  source: 'cal.com' | 'manual'
  attendee_email: string
  attendee_name: string
  attendee_company?: string
  attendee_timezone?: string
  organizer_email: string       // Adam's email
  title: string
  description?: string
  start_time: string            // ISO
  end_time: string              // ISO
  duration_min: number
  status: MeetingStatus
  lead_domain?: string          // matched lead in DB
  cal_event_type_id?: number
  cal_reschedule_url?: string
  cal_cancel_url?: string
  // Set by the pre-call brief generator when it runs
  prep_brief_id?: string
  prep_brief_generated_at?: string
  // Set when the meeting actually happens (we'll wire from BOOKING.RECORDING_READY or manual)
  completed_at?: string
  no_show_at?: string
  created_at: string
  updated_at: string
}

async function loadList(): Promise<Meeting[]> {
  const list = await kv().lrange<Meeting>(MEETINGS_KEY, 0, -1)
  return Array.isArray(list) ? list : []
}

async function saveList(list: Meeting[]): Promise<void> {
  // We RPUSH in append-only mode but we sometimes need to MUTATE existing
  // records (status changes, brief attachment). KV lrange returns a snapshot;
  // mutating means overwriting the whole list. For ≤500 meetings that's fine.
  // We delete + rebuild so the order stays deterministic (oldest first).
  await kv().del(MEETINGS_KEY)
  for (const m of list.slice(-MAX_MEETINGS_KEPT)) {
    await kv().rpush(MEETINGS_KEY, m)
  }
}

// =====================================================================
// CREATE / UPDATE
// =====================================================================

export interface UpsertMeetingInput {
  id: string
  source?: 'cal.com' | 'manual'
  attendee_email: string
  attendee_name: string
  attendee_company?: string
  attendee_timezone?: string
  organizer_email?: string
  title: string
  description?: string
  start_time: string
  end_time: string
  status?: MeetingStatus
  cal_event_type_id?: number
  cal_reschedule_url?: string
  cal_cancel_url?: string
}

export async function upsertMeeting(input: UpsertMeetingInput): Promise<Meeting> {
  const list = await loadList()
  const idx = list.findIndex(m => m.id === input.id)
  const now = new Date().toISOString()
  const durationMin = Math.max(
    1,
    Math.round((new Date(input.end_time).getTime() - new Date(input.start_time).getTime()) / 60000),
  )

  // Try to match attendee email to a lead in the DB (by email domain)
  const emailDomain = normalizeDomain((input.attendee_email.split('@')[1] ?? ''))
  let leadDomain: string | undefined
  if (emailDomain) {
    const lead = await getLead(emailDomain)
    if (lead) leadDomain = lead.domain
  }

  let merged: Meeting
  if (idx >= 0) {
    const existing = list[idx]!
    merged = {
      ...existing,
      ...input,
      duration_min: durationMin,
      status: input.status ?? existing.status,
      ...(leadDomain ? { lead_domain: leadDomain } : existing.lead_domain ? { lead_domain: existing.lead_domain } : {}),
      organizer_email: input.organizer_email ?? existing.organizer_email,
      source: input.source ?? existing.source,
      updated_at: now,
    }
    list[idx] = merged
  } else {
    merged = {
      id: input.id,
      source: input.source ?? 'cal.com',
      attendee_email: input.attendee_email.toLowerCase(),
      attendee_name: input.attendee_name,
      ...(input.attendee_company ? { attendee_company: input.attendee_company } : {}),
      ...(input.attendee_timezone ? { attendee_timezone: input.attendee_timezone } : {}),
      organizer_email: input.organizer_email ?? '',
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      start_time: input.start_time,
      end_time: input.end_time,
      duration_min: durationMin,
      status: input.status ?? 'booked',
      ...(leadDomain ? { lead_domain: leadDomain } : {}),
      ...(input.cal_event_type_id !== undefined ? { cal_event_type_id: input.cal_event_type_id } : {}),
      ...(input.cal_reschedule_url ? { cal_reschedule_url: input.cal_reschedule_url } : {}),
      ...(input.cal_cancel_url ? { cal_cancel_url: input.cal_cancel_url } : {}),
      created_at: now,
      updated_at: now,
    }
    list.push(merged)
  }

  await saveList(list)

  // Mirror to the lead record if matched
  if (leadDomain) {
    try {
      const lead = await getLead(leadDomain)
      await upsertLead({
        domain: leadDomain,
        business_name: lead?.business_name ?? input.attendee_company ?? leadDomain,
        status: merged.status === 'booked' ? 'replied_positive' : lead?.status ?? 'replied_positive',
      })
      await recordInteraction(leadDomain, {
        type: 'noted',
        source: 'cal.com',
        details: {
          meeting_id: merged.id,
          meeting_status: merged.status,
          start_time: merged.start_time,
          title: merged.title,
        },
      })
    } catch { /* best-effort */ }
  }

  return merged
}

export async function setMeetingStatus(id: string, status: MeetingStatus): Promise<Meeting | null> {
  const list = await loadList()
  const idx = list.findIndex(m => m.id === id)
  if (idx < 0) return null
  const m = list[idx]!
  m.status = status
  m.updated_at = new Date().toISOString()
  if (status === 'completed') m.completed_at = m.updated_at
  if (status === 'no_show') m.no_show_at = m.updated_at
  list[idx] = m
  await saveList(list)
  return m
}

export async function attachBrief(meetingId: string, briefId: string): Promise<boolean> {
  const list = await loadList()
  const idx = list.findIndex(m => m.id === meetingId)
  if (idx < 0) return false
  const m = list[idx]!
  m.prep_brief_id = briefId
  m.prep_brief_generated_at = new Date().toISOString()
  m.updated_at = m.prep_brief_generated_at
  list[idx] = m
  await saveList(list)
  return true
}

export async function attachLeadDomain(meetingId: string, domain: string): Promise<boolean> {
  const list = await loadList()
  const idx = list.findIndex(m => m.id === meetingId)
  if (idx < 0) return false
  const d = normalizeDomain(domain)
  if (!d) return false
  const m = list[idx]!
  m.lead_domain = d
  m.updated_at = new Date().toISOString()
  list[idx] = m
  await saveList(list)
  return true
}

// =====================================================================
// READ
// =====================================================================

export async function getMeeting(id: string): Promise<Meeting | null> {
  const list = await loadList()
  return list.find(m => m.id === id) ?? null
}

export async function listUpcomingMeetings(opts: { within_hours?: number; include_cancelled?: boolean } = {}): Promise<Meeting[]> {
  const list = await loadList()
  const now = Date.now()
  const horizon = opts.within_hours ? now + opts.within_hours * 3600 * 1000 : Infinity
  const filtered = list.filter(m => {
    if (!opts.include_cancelled && m.status === 'cancelled') return false
    const t = new Date(m.start_time).getTime()
    return t >= now && t <= horizon
  })
  filtered.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())
  return filtered
}

export async function listAllMeetings(limit = 50): Promise<Meeting[]> {
  const list = await loadList()
  const sorted = [...list].sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime())
  return sorted.slice(0, limit)
}

export async function meetingsNeedingBriefs(): Promise<Meeting[]> {
  // Anything starting in the next 24h that doesn't yet have a brief
  const list = await listUpcomingMeetings({ within_hours: 26 })
  return list.filter(m => !m.prep_brief_id && m.status === 'booked')
}
