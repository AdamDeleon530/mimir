/**
 * Gmail SMTP sender with inbox rotation + per-inbox daily caps.
 *
 * Reads inboxes from env: NUXT_GMAIL_INBOX_N_EMAIL + NUXT_GMAIL_INBOX_N_PASSWORD (N = 1, 2, ...)
 * Requires Gmail App Passwords (https://myaccount.google.com/apppasswords) — 2FA must be enabled.
 *
 * Daily cap per inbox: 30 (Gmail soft limit is ~500/day but cold-email best practice is much lower)
 */
import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
import { inboxSentToday } from './sequence-state'

const MAX_PER_INBOX_PER_DAY = 30

interface Inbox {
  email: string
  password: string
}

let cachedInboxes: Inbox[] | null = null
const transporterCache = new Map<string, Transporter>()

function loadInboxes(): Inbox[] {
  if (cachedInboxes) return cachedInboxes
  const inboxes: Inbox[] = []
  for (let i = 1; i <= 10; i++) {
    const email = process.env[`NUXT_GMAIL_INBOX_${i}_EMAIL`]
    const password = process.env[`NUXT_GMAIL_INBOX_${i}_PASSWORD`]
    if (email && password) inboxes.push({ email, password: password.replace(/\s/g, '') })
  }
  cachedInboxes = inboxes
  return inboxes
}

function getTransporter(inbox: Inbox): Transporter {
  const cached = transporterCache.get(inbox.email)
  if (cached) return cached
  const t = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: inbox.email, pass: inbox.password },
  })
  transporterCache.set(inbox.email, t)
  return t
}

/**
 * Picks the inbox with the lowest sent-today count. Returns null if all are at cap.
 */
export async function pickNextInbox(): Promise<Inbox | null> {
  const inboxes = loadInboxes()
  if (!inboxes.length) return null
  const counts = await Promise.all(inboxes.map(async (i) => ({ inbox: i, count: await inboxSentToday(i.email) })))
  counts.sort((a, b) => a.count - b.count)
  const cheapest = counts[0]
  if (!cheapest) return null
  if (cheapest.count >= MAX_PER_INBOX_PER_DAY) return null
  return cheapest.inbox
}

export async function inboxStatus(): Promise<Array<{ email: string; sent_today: number; cap: number; can_send: boolean }>> {
  const inboxes = loadInboxes()
  return Promise.all(inboxes.map(async (i) => {
    const sent = await inboxSentToday(i.email)
    return { email: i.email, sent_today: sent, cap: MAX_PER_INBOX_PER_DAY, can_send: sent < MAX_PER_INBOX_PER_DAY }
  }))
}

export async function sendEmail(opts: {
  from: Inbox
  to: string
  toName?: string
  subject: string
  body: string
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  try {
    const t = getTransporter(opts.from)
    const fromHeader = `Adam — The Nordic Nerd <${opts.from.email}>`
    const toHeader = opts.toName ? `${opts.toName} <${opts.to}>` : opts.to
    const info = await t.sendMail({
      from: fromHeader,
      to: toHeader,
      subject: opts.subject,
      text: opts.body,
    })
    return { ok: true, messageId: info.messageId }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown send error' }
  }
}

export function inboxesConfigured(): number {
  return loadInboxes().length
}
