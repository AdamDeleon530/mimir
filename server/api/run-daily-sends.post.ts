/**
 * POST /api/run-daily-sends
 * Called by Cowork scheduled task (weekdays 9:30am ET).
 * Processes the sequence queue: for each due lead, send the next email step via Gmail SMTP.
 * Respects per-inbox daily caps. Records sends + advances state.
 *
 * Auth: requires Mimir session cookie OR a secret header (X-Cron-Secret) for headless invocation.
 */
import { findDueLeads, recordSend, type SequencedLead } from '~/server/utils/sequence-state'
import { pickNextInbox, sendEmail, inboxesConfigured } from '~/server/utils/email-sender'
import { POLK_RELAXED_V1, renderTemplate } from '~/server/utils/sequence-templates'

export default defineEventHandler(async (event) => {
  // Auth: either user session OR cron secret
  const session = getCookie(event, 'mimir-session')
  const cronSecret = getHeader(event, 'x-cron-secret')
  const expectedSecret = process.env.NUXT_CRON_SECRET
  if (!session && (!expectedSecret || cronSecret !== expectedSecret)) {
    throw createError({ statusCode: 401, message: 'unauthorized' })
  }

  if (inboxesConfigured() === 0) {
    return { ok: false, error: 'no inboxes configured — set NUXT_GMAIL_INBOX_1_EMAIL + NUXT_GMAIL_INBOX_1_PASSWORD' }
  }

  const due = await findDueLeads()
  const results: Array<{ email: string; step: number; status: string; inbox?: string; error?: string }> = []

  for (const lead of due) {
    const inbox = await pickNextInbox()
    if (!inbox) {
      results.push({ email: lead.email, step: lead.current_step + 1, status: 'skipped — all inboxes at daily cap' })
      break
    }

    const nextStep = lead.current_step + 1
    const template = POLK_RELAXED_V1.find(s => s.step === nextStep)
    if (!template) {
      results.push({ email: lead.email, step: nextStep, status: 'skipped — no template for step' })
      continue
    }

    const mergeVars: Record<string, string> = {
      first_name: lead.first_name || 'there',
      last_name: lead.last_name,
      company_name: lead.company_name,
      city: lead.city,
      niche: lead.niche,
      first_line: lead.first_line,
      physical_address: process.env.NUXT_PHYSICAL_ADDRESS ?? '',
    }
    const subject = renderTemplate(template.subject, mergeVars)
    const body = renderTemplate(template.body, mergeVars)

    const sendResult = await sendEmail({
      from: inbox,
      to: lead.email,
      toName: `${lead.first_name} ${lead.last_name}`.trim(),
      subject,
      body,
    })

    const event_record = {
      step: nextStep,
      sent_at: new Date().toISOString(),
      inbox: inbox.email,
      subject,
      status: (sendResult.ok ? 'sent' : 'failed') as 'sent' | 'failed',
      ...(sendResult.error ? { error: sendResult.error } : {}),
    }

    const nextTemplate = POLK_RELAXED_V1.find(s => s.step === nextStep + 1)
    await recordSend(lead.email, event_record, nextTemplate ? nextTemplate.delay_days : null)

    results.push({
      email: lead.email,
      step: nextStep,
      status: sendResult.ok ? 'sent' : 'failed',
      inbox: inbox.email,
      ...(sendResult.error ? { error: sendResult.error } : {}),
    })

    // Small spacing between sends (~2s) to look human + avoid Gmail micro-bursts
    await new Promise(r => setTimeout(r, 2000))
  }

  const sent = results.filter(r => r.status === 'sent').length
  const failed = results.filter(r => r.status === 'failed').length
  const skipped = results.filter(r => r.status.startsWith('skipped')).length

  return {
    ok: true,
    asOf: new Date().toISOString(),
    summary: { total: results.length, sent, failed, skipped },
    results,
  }
})
