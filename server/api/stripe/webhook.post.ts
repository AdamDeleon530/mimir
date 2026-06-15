/**
 * POST /api/stripe/webhook
 *
 * Stripe events we care about:
 *   - invoice.paid                          → client active, MTD revenue bumps
 *   - invoice.payment_failed                → mark client past_due
 *   - customer.subscription.deleted         → mark client cancelled
 *
 * Setup in Stripe dashboard:
 *   1. Developers → Webhooks → Add endpoint
 *   2. URL: https://<your-vercel-url>/api/stripe/webhook
 *   3. Events: select the three above
 *   4. Reveal signing secret, paste into NUXT_STRIPE_WEBHOOK_SECRET
 *
 * Stripe signature format: t=<ts>,v1=<sig>. We compute HMAC-SHA256 over
 * `<ts>.<raw_body>` using the signing secret. Done manually (no SDK).
 */
import crypto from 'node:crypto'
import { handleStripeInvoicePaid, handleStripeInvoiceFailed, handleStripeSubscriptionCancelled } from '~/server/utils/stripe-client'

interface StripeEvent {
  id: string
  type: string
  data: {
    object: {
      id: string
      customer?: string
      subscription?: string
      amount_paid?: number
      amount?: number
    }
  }
}

export default defineEventHandler(async (event) => {
  const bodyText = (await readRawBody(event)) ?? ''

  const secret = process.env.NUXT_STRIPE_WEBHOOK_SECRET
  if (secret) {
    const header = getHeader(event, 'stripe-signature') ?? ''
    if (!verifyStripeSignature(bodyText, header, secret)) {
      throw createError({ statusCode: 401, message: 'invalid signature' })
    }
  } else {
    console.warn('[stripe webhook] NUXT_STRIPE_WEBHOOK_SECRET not set — accepting unsigned webhook (dev mode only)')
  }

  let evt: StripeEvent
  try {
    evt = JSON.parse(bodyText) as StripeEvent
  } catch {
    throw createError({ statusCode: 400, message: 'invalid JSON' })
  }

  const obj = evt.data?.object
  if (!obj) return { ok: true, ignored: true, reason: 'no object' }

  switch (evt.type) {
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      if (obj.customer) {
        await handleStripeInvoicePaid({
          customerId: obj.customer,
          amount: obj.amount_paid ?? obj.amount ?? 0,
          ...(obj.subscription ? { subscriptionId: obj.subscription } : {}),
        })
      }
      return { ok: true, event: evt.type }
    }
    case 'invoice.payment_failed': {
      if (obj.customer) {
        await handleStripeInvoiceFailed({
          customerId: obj.customer,
          ...(obj.subscription ? { subscriptionId: obj.subscription } : {}),
        })
      }
      return { ok: true, event: evt.type }
    }
    case 'customer.subscription.deleted': {
      if (obj.customer && obj.id) {
        await handleStripeSubscriptionCancelled({
          customerId: obj.customer,
          subscriptionId: obj.id,
        })
      }
      return { ok: true, event: evt.type }
    }
    default:
      return { ok: true, ignored: true, reason: `unhandled event ${evt.type}` }
  }
})

function verifyStripeSignature(body: string, header: string, secret: string): boolean {
  // header format: t=1234567890,v1=signature,v1=alt
  const parts = header.split(',')
  let ts = ''
  const sigs: string[] = []
  for (const part of parts) {
    const [k, v] = part.split('=')
    if (!k || !v) continue
    if (k.trim() === 't') ts = v.trim()
    else if (k.trim() === 'v1') sigs.push(v.trim())
  }
  if (!ts || sigs.length === 0) return false
  const expected = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')
  for (const sig of sigs) {
    try {
      if (sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) {
        return true
      }
    } catch { /* malformed sig, skip */ }
  }
  return false
}
