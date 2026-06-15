/**
 * POST /api/documenso/webhook
 *
 * Documenso fires these on document lifecycle events. We care most about
 * DOCUMENT_SIGNED — that's the moment to spin up the Stripe customer +
 * subscription. DOCUMENT_VIEWED gives Adam a "they're looking at it"
 * signal in the dashboard.
 *
 * Setup in Documenso:
 *   1. Admin → Webhooks → Create
 *   2. URL: https://<your-vercel-url>/api/documenso/webhook
 *   3. Events: DOCUMENT_VIEWED, DOCUMENT_SIGNED, DOCUMENT_REJECTED
 *   4. Secret: paste it into NUXT_DOCUMENSO_WEBHOOK_SECRET
 *
 * Documenso signs with HMAC-SHA256 of the raw body, sent in X-Documenso-Signature.
 */
import crypto from 'node:crypto'
import { updateProposalStatus } from '~/server/utils/documenso'
import { createClientFromProposal } from '~/server/utils/stripe-client'

interface DocumensoWebhookPayload {
  event: 'DOCUMENT_CREATED' | 'DOCUMENT_SENT' | 'DOCUMENT_VIEWED' | 'DOCUMENT_SIGNED' | 'DOCUMENT_REJECTED' | 'DOCUMENT_COMPLETED' | string
  createdAt: string
  webhookEndpoint?: string
  payload?: {
    id?: number | string
    documentId?: number | string
    status?: string
    title?: string
    recipients?: Array<{ email?: string; name?: string; signingStatus?: string }>
  }
}

export default defineEventHandler(async (event) => {
  const bodyText = (await readRawBody(event)) ?? ''

  const secret = process.env.NUXT_DOCUMENSO_WEBHOOK_SECRET
  if (secret) {
    const provided = getHeader(event, 'x-documenso-signature') ?? ''
    const expected = crypto.createHmac('sha256', secret).update(bodyText).digest('hex')
    if (!constantTimeEqual(provided, expected)) {
      throw createError({ statusCode: 401, message: 'invalid signature' })
    }
  } else {
    console.warn('[documenso webhook] NUXT_DOCUMENSO_WEBHOOK_SECRET not set — accepting unsigned webhook (dev mode only)')
  }

  let webhook: DocumensoWebhookPayload
  try {
    webhook = JSON.parse(bodyText) as DocumensoWebhookPayload
  } catch {
    throw createError({ statusCode: 400, message: 'invalid JSON' })
  }

  const docId = String(webhook.payload?.documentId ?? webhook.payload?.id ?? '')
  if (!docId) {
    return { ok: true, ignored: true, reason: 'no document id' }
  }

  switch (webhook.event) {
    case 'DOCUMENT_VIEWED': {
      const p = await updateProposalStatus({ id: docId, status: 'viewed', occurred_at: webhook.createdAt })
      return { ok: true, event: 'viewed', proposal_id: docId, lead_domain: p?.lead_domain ?? null }
    }
    case 'DOCUMENT_SIGNED':
    case 'DOCUMENT_COMPLETED': {
      const p = await updateProposalStatus({ id: docId, status: 'signed', occurred_at: webhook.createdAt })
      // The moment that matters — spin up Stripe customer + subscription
      if (p) {
        try {
          await createClientFromProposal(p)
        } catch (err) {
          console.error('[documenso webhook] stripe activation failed:', err)
          return {
            ok: true, event: 'signed', proposal_id: docId,
            stripe_error: err instanceof Error ? err.message : 'unknown',
          }
        }
      }
      return { ok: true, event: 'signed', proposal_id: docId, lead_domain: p?.lead_domain ?? null }
    }
    case 'DOCUMENT_REJECTED': {
      const p = await updateProposalStatus({ id: docId, status: 'declined', occurred_at: webhook.createdAt })
      return { ok: true, event: 'declined', proposal_id: docId, lead_domain: p?.lead_domain ?? null }
    }
    default:
      return { ok: true, ignored: true, reason: `unhandled event ${webhook.event}` }
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
