/**
 * POST /api/cal/webhook
 *
 * Cal.com calls this whenever a booking happens, gets cancelled, or
 * reschedules. We use it to surface meetings to Mimir so the pre-call
 * brief generator can run, the dashboard shows upcoming calls, and
 * Adam isn't surprised when his calendar buzzes.
 *
 * Setup in Cal.com:
 *   1. Settings → Developer → Webhooks → New
 *   2. URL: https://<your-vercel-url>/api/cal/webhook
 *   3. Subscribe to: BOOKING_CREATED, BOOKING_CANCELLED, BOOKING_RESCHEDULED
 *   4. Secret: any string — paste it into NUXT_CAL_WEBHOOK_SECRET
 *
 * Cal.com signs the body with HMAC-SHA256 of the raw payload using your
 * secret, sent in X-Cal-Signature-256.
 */
import crypto from 'node:crypto'
import { upsertMeeting, setMeetingStatus, type UpsertMeetingInput } from '~/server/utils/meetings'

interface CalAttendee {
  email: string
  name: string
  timeZone?: string
  language?: { locale?: string }
}

interface CalBookingPayload {
  type?: string                  // event type slug
  title?: string
  description?: string
  additionalNotes?: string
  customInputs?: Record<string, unknown>
  startTime?: string
  endTime?: string
  organizer?: { email: string; name?: string; timeZone?: string }
  attendees?: CalAttendee[]
  uid?: string                   // unique booking id
  bookingId?: number
  eventTypeId?: number
  status?: string
  rescheduleUid?: string
  cancellationReason?: string
  rescheduleUrl?: string
  cancelUrl?: string
  metadata?: Record<string, unknown>
  responses?: Record<string, { value?: string; label?: string }>
}

interface CalWebhookEnvelope {
  triggerEvent: 'BOOKING_CREATED' | 'BOOKING_CANCELLED' | 'BOOKING_RESCHEDULED' | 'MEETING_ENDED' | string
  createdAt: string
  payload: CalBookingPayload
}

export default defineEventHandler(async (event) => {
  const bodyText = (await readRawBody(event)) ?? ''

  // Signature check (skipped if no secret set — but warn in logs)
  const secret = process.env.NUXT_CAL_WEBHOOK_SECRET
  if (secret) {
    const provided = getHeader(event, 'x-cal-signature-256') ?? ''
    const expected = crypto.createHmac('sha256', secret).update(bodyText).digest('hex')
    if (!constantTimeEqual(provided, expected)) {
      throw createError({ statusCode: 401, message: 'invalid signature' })
    }
  } else {
    console.warn('[cal webhook] NUXT_CAL_WEBHOOK_SECRET not set — accepting unsigned webhook (dev mode only)')
  }

  let envelope: CalWebhookEnvelope
  try {
    envelope = JSON.parse(bodyText) as CalWebhookEnvelope
  } catch {
    throw createError({ statusCode: 400, message: 'invalid JSON' })
  }

  const p = envelope.payload
  if (!p || !p.uid || !p.startTime || !p.endTime) {
    // Acknowledge but skip — Cal sends some events we don't care about
    return { ok: true, ignored: true, reason: 'incomplete payload' }
  }

  const attendee = p.attendees?.[0]
  if (!attendee?.email) {
    return { ok: true, ignored: true, reason: 'no attendee email' }
  }

  // Try to pull the contractor's company name from custom responses
  const company = String(
    p.responses?.company?.value ??
    p.responses?.companyName?.value ??
    p.metadata?.company ??
    ''
  )

  const baseInput: UpsertMeetingInput = {
    id: p.uid,
    source: 'cal.com',
    attendee_email: attendee.email,
    attendee_name: attendee.name || attendee.email.split('@')[0]!,
    ...(company ? { attendee_company: company } : {}),
    ...(attendee.timeZone ? { attendee_timezone: attendee.timeZone } : {}),
    organizer_email: p.organizer?.email ?? '',
    title: p.title ?? `Call with ${attendee.name ?? attendee.email}`,
    ...(p.description || p.additionalNotes ? { description: p.description ?? p.additionalNotes } : {}),
    start_time: p.startTime,
    end_time: p.endTime,
    ...(p.eventTypeId !== undefined ? { cal_event_type_id: p.eventTypeId } : {}),
    ...(p.rescheduleUrl ? { cal_reschedule_url: p.rescheduleUrl } : {}),
    ...(p.cancelUrl ? { cal_cancel_url: p.cancelUrl } : {}),
  }

  switch (envelope.triggerEvent) {
    case 'BOOKING_CREATED': {
      const m = await upsertMeeting({ ...baseInput, status: 'booked' })
      return { ok: true, event: 'created', meeting_id: m.id, lead_domain: m.lead_domain ?? null }
    }
    case 'BOOKING_RESCHEDULED': {
      const m = await upsertMeeting({ ...baseInput, status: 'rescheduled' })
      // After bookkeeping, treat as a new booking — Cal sometimes sends a new uid
      // for the rescheduled slot, which upsertMeeting handles as a new record
      return { ok: true, event: 'rescheduled', meeting_id: m.id }
    }
    case 'BOOKING_CANCELLED': {
      // Make sure the record exists, then mark cancelled
      await upsertMeeting({ ...baseInput, status: 'cancelled' })
      const m = await setMeetingStatus(p.uid, 'cancelled')
      return { ok: true, event: 'cancelled', meeting_id: m?.id ?? p.uid }
    }
    case 'MEETING_ENDED': {
      const m = await setMeetingStatus(p.uid, 'completed')
      return { ok: true, event: 'completed', meeting_id: m?.id ?? p.uid }
    }
    default:
      return { ok: true, ignored: true, reason: `unhandled triggerEvent ${envelope.triggerEvent}` }
  }
})

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}
