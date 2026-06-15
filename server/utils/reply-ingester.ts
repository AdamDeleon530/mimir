/**
 * Reply ingestion via IMAP over the same Gmail App Password creds we use
 * for sending. Polls unread messages, runs them through Claude to classify
 * + draft a response, auto-pauses the corresponding sequence lead.
 *
 * Pending replies are stored in KV under mimir:pending-replies so Mimir's
 * read tool (get_pending_replies — to be re-added in tools.ts) can surface
 * them. The reply state per-email is tracked under mimir:replies:seen
 * (Set) so we don't re-process the same message twice.
 *
 * imapflow is a thin, modern IMAP client. Added as a dep.
 */
import Anthropic from '@anthropic-ai/sdk'
import { ImapFlow } from 'imapflow'
import { kv } from './kv'
import { pauseLead } from './sequence-state'
import { markDoNotContact, normalizeDomain, recordInteraction, upsertLead } from './lead-db'
import { creditReplyToVariant } from './ab-testing'

interface InboxCred {
  email: string
  password: string
}

function loadInboxes(): InboxCred[] {
  const out: InboxCred[] = []
  for (let i = 1; i <= 10; i++) {
    const email = process.env[`NUXT_GMAIL_INBOX_${i}_EMAIL`]
    const password = process.env[`NUXT_GMAIL_INBOX_${i}_PASSWORD`]
    if (email && password) out.push({ email, password: password.replace(/\s/g, '') })
  }
  return out
}

const SEEN_KEY = 'mimir:replies:seen'
const PENDING_KEY = 'mimir:pending-replies'
const MAX_PENDING_KEPT = 50

export interface PendingReply {
  id: string                          // hash of message-id
  received_at: string
  inbox: string                       // which Gmail inbox got it
  from: string
  from_name: string
  subject: string
  body: string                        // plain-text excerpt, up to ~3KB
  classification: ReplyClass
  intent_signal: 'high' | 'medium' | 'low' | 'none'
  draft: string                       // suggested response (empty if none)
  paused_in_queue: boolean
  escalate: boolean
  escalation_reason?: string
}

type ReplyClass = 'positive' | 'question' | 'objection' | 'unsubscribe' | 'ooo' | 'negative' | 'other'

interface ClassifierOutput {
  classification: ReplyClass
  confidence: number
  summary: string
  intent_signal: 'high' | 'medium' | 'low' | 'none'
  escalate: boolean
  escalation_reason?: string
}

const CLASSIFIER_PROMPT = `You classify a single inbound reply to one of Adam's cold outbound emails. Return ONE JSON object — no prose, no markdown, no surrounding text.

Schema:
{
  "classification": "positive" | "question" | "objection" | "unsubscribe" | "ooo" | "negative" | "other",
  "confidence": 0-1,
  "summary": "one sentence, plain",
  "intent_signal": "high" | "medium" | "low" | "none",
  "escalate": true | false,
  "escalation_reason": "string or omit"
}

Rules:
- "positive" = interested, wants a call, asks for next steps
- "question" = clarifying question (pricing, scope, timeline) without saying yes/no
- "objection" = polite "no thanks", "we have someone", "not now"
- "unsubscribe" = remove me, stop emailing, take me off the list
- "ooo" = out-of-office autoresponder
- "negative" = hostile or angry
- "other" = anything else (bounce notification, system message, etc.)

Escalate=true ONLY when: confidence<0.6, classification is "negative", or the reply mentions lawyer/attorney/complaint/FTC/CAN-SPAM/sue.

intent_signal=high when classification is "positive" AND the reply asks to book / wants pricing / shows urgency.`

const DRAFTER_PROMPT = `You are Adam at The Nordic Nerd. Draft a SHORT, peer-to-peer response to a contractor's reply. Voice DNA: dry, calm, technical, never "leverage" or "solutions" or salesy. Sign as "Adam".

You receive: the original cold email, the inbound reply, the classification, the sender's first name.

Output PLAIN TEXT — no greeting beyond "Hey <first_name>," — no markdown, no signature block beyond "— Adam".

Length: 2-4 sentences for positive/question, 1-2 sentences for objection/ooo.

If classification is "positive" or "question": move toward a call. Cal.com link is calendar.app.google/JheMSKoDMrWkiixy6.
If classification is "objection": acknowledge gracefully, leave the door open.
If classification is "ooo": output exactly "DRAFT_SKIP" — Adam wants to wait.
If classification is "unsubscribe" or "negative": output exactly "DRAFT_SKIP" — Adam handles these personally.

Never invent details. Reference the contractor's actual words sparingly.`

export interface PollResult {
  ok: boolean
  inboxes_polled: number
  new_replies: number
  classified: number
  drafted: number
  errors: string[]
}

export async function pollAllInboxes(): Promise<PollResult> {
  const inboxes = loadInboxes()
  if (inboxes.length === 0) {
    return { ok: false, inboxes_polled: 0, new_replies: 0, classified: 0, drafted: 0, errors: ['no inboxes configured'] }
  }
  const anthropicKey = process.env.NUXT_ANTHROPIC_API_KEY
  if (!anthropicKey) {
    return { ok: false, inboxes_polled: 0, new_replies: 0, classified: 0, drafted: 0, errors: ['NUXT_ANTHROPIC_API_KEY not set'] }
  }
  const client = new Anthropic({ apiKey: anthropicKey })

  let newReplies = 0
  let classified = 0
  let drafted = 0
  const errors: string[] = []

  for (const inbox of inboxes) {
    try {
      const fetched = await fetchUnreadFromInbox(inbox)
      newReplies += fetched.length

      for (const msg of fetched) {
        try {
          const cls = await classifyReply(client, msg)
          classified++

          let draft = ''
          if (cls.classification !== 'ooo' && cls.classification !== 'unsubscribe' && cls.classification !== 'negative') {
            draft = await draftReply(client, msg, cls)
            if (draft && draft !== 'DRAFT_SKIP') drafted++
            else draft = ''
          }

          let paused = false
          if (cls.classification !== 'ooo' && cls.classification !== 'other') {
            const pauseReason: 'replied' | 'unsubscribed' = cls.classification === 'unsubscribe' ? 'unsubscribed' : 'replied'
            paused = await pauseLead(msg.from, pauseReason)
          }

          // Credit the A/B variant — figures out which step's subject was
          // last sent to this address and bumps replied / replied_positive.
          await creditReplyToVariant({
            email: msg.from,
            classification: cls.classification,
          }).catch(() => { /* best-effort */ })

          // Mirror to lead DB. Replies — even objections — go to DNC so we
          // don't burn trust with a follow-up after someone explicitly closed
          // the loop. OOO is the one exception: don't suppress an autoresponder.
          const replyDomain = normalizeDomain((msg.from.split('@')[1] ?? ''))
          if (replyDomain) {
            try {
              if (cls.classification === 'unsubscribe') {
                await markDoNotContact(replyDomain, 'unsubscribed')
              } else if (cls.classification === 'negative') {
                await markDoNotContact(replyDomain, 'negative')
              } else if (cls.classification !== 'ooo' && cls.classification !== 'other') {
                // positive / question / objection — all stop further outbound
                await markDoNotContact(replyDomain, 'replied')
              } else {
                await upsertLead({
                  domain: replyDomain,
                  business_name: msg.from_name || replyDomain,
                  last_reply_at: msg.received_at,
                })
              }
              await recordInteraction(replyDomain, {
                type: 'reply_received',
                source: inbox.email,
                details: {
                  classification: cls.classification,
                  intent_signal: cls.intent_signal,
                  summary: cls.summary,
                  escalate: cls.escalate,
                },
              })
            } catch { /* best-effort */ }
          }

          const pending: PendingReply = {
            id: msg.id,
            received_at: msg.received_at,
            inbox: inbox.email,
            from: msg.from,
            from_name: msg.from_name,
            subject: msg.subject,
            body: msg.body.slice(0, 3000),
            classification: cls.classification,
            intent_signal: cls.intent_signal,
            draft,
            paused_in_queue: paused,
            escalate: cls.escalate,
            ...(cls.escalation_reason ? { escalation_reason: cls.escalation_reason } : {}),
          }
          await kv().rpush(PENDING_KEY, pending)
          await kv().ltrim(PENDING_KEY, -MAX_PENDING_KEPT, -1)
        } catch (err) {
          errors.push(`classify failed for ${msg.from}: ${err instanceof Error ? err.message : 'unknown'}`)
        }
      }
    } catch (err) {
      errors.push(`${inbox.email}: ${err instanceof Error ? err.message : 'unknown'}`)
    }
  }

  return {
    ok: errors.length === 0,
    inboxes_polled: inboxes.length,
    new_replies: newReplies,
    classified,
    drafted,
    errors: errors.slice(0, 10),
  }
}

// =====================================================================
// IMAP fetch
// =====================================================================

interface RawMessage {
  id: string
  message_id: string
  from: string
  from_name: string
  subject: string
  body: string
  received_at: string
}

async function fetchUnreadFromInbox(inbox: InboxCred): Promise<RawMessage[]> {
  const messages: RawMessage[] = []
  const seenSet = await loadSeenIds()

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: inbox.email, pass: inbox.password },
    logger: false,
  })

  await client.connect()
  try {
    await client.mailboxOpen('INBOX')
    // Only the last 7 days of unread to keep poll cost predictable
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000)
    for await (const msg of client.fetch({ seen: false, since }, { envelope: true, source: true })) {
      const messageId = msg.envelope?.messageId ?? `${inbox.email}:${msg.uid}`
      const id = hashId(messageId)
      if (seenSet.has(id)) continue
      const from = msg.envelope?.from?.[0]
      const fromAddress = (from?.address ?? '').toLowerCase()
      if (!fromAddress) continue

      const sourceBuf = msg.source as Buffer | undefined
      const raw = sourceBuf ? sourceBuf.toString('utf-8') : ''
      const body = extractPlainBody(raw)

      messages.push({
        id,
        message_id: messageId,
        from: fromAddress,
        from_name: from?.name ?? '',
        subject: msg.envelope?.subject ?? '(no subject)',
        body,
        received_at: msg.envelope?.date?.toISOString() ?? new Date().toISOString(),
      })
      seenSet.add(id)
    }
  } finally {
    await client.logout().catch(() => { /* ignore */ })
  }

  // Persist seen IDs (we keep the last ~5000)
  await saveSeenIds(seenSet)
  return messages
}

// =====================================================================
// Helpers
// =====================================================================

async function loadSeenIds(): Promise<Set<string>> {
  const arr = await kv().get<string[]>(SEEN_KEY)
  return new Set(Array.isArray(arr) ? arr : [])
}

async function saveSeenIds(set: Set<string>): Promise<void> {
  const arr = [...set].slice(-5000)
  await kv().set(SEEN_KEY, arr)
}

function hashId(s: string): string {
  // Lightweight non-crypto hash — collisions are fine, we just need a stable key
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return `r-${h >>> 0}`
}

function extractPlainBody(raw: string): string {
  // Tiny MIME extractor — grab text/plain part if multipart, else the body after headers
  const lower = raw.toLowerCase()
  const plainIdx = lower.indexOf('content-type: text/plain')
  if (plainIdx >= 0) {
    const fromPlain = raw.slice(plainIdx)
    const blank = fromPlain.indexOf('\r\n\r\n')
    if (blank >= 0) {
      const partEnd = fromPlain.indexOf('\r\n--', blank)
      const body = fromPlain.slice(blank + 4, partEnd >= 0 ? partEnd : undefined)
      return decode(body).slice(0, 8000)
    }
  }
  // Fallback: drop headers (first blank line)
  const blank = raw.indexOf('\r\n\r\n')
  return decode(blank >= 0 ? raw.slice(blank + 4) : raw).slice(0, 8000)
}

function decode(s: string): string {
  return s
    .replace(/=\r?\n/g, '')          // soft line breaks
    .replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/<[^>]+>/g, ' ')        // strip inline HTML if any leaked through
    .replace(/\s+/g, ' ')
    .trim()
}

// =====================================================================
// Claude calls
// =====================================================================

async function classifyReply(client: Anthropic, msg: RawMessage): Promise<ClassifierOutput> {
  const resp = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    temperature: 0,
    system: CLASSIFIER_PROMPT,
    messages: [{
      role: 'user',
      content: JSON.stringify({
        from: msg.from,
        from_name: msg.from_name,
        subject: msg.subject,
        body: msg.body.slice(0, 3000),
      }),
    }],
  })
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim()
  try {
    const parsed = JSON.parse(text) as ClassifierOutput
    return parsed
  } catch {
    return {
      classification: 'other',
      confidence: 0,
      summary: 'classifier returned non-JSON',
      intent_signal: 'none',
      escalate: true,
      escalation_reason: 'classifier_json_parse_failed',
    }
  }
}

async function draftReply(client: Anthropic, msg: RawMessage, cls: ClassifierOutput): Promise<string> {
  const model = cls.intent_signal === 'high' ? 'claude-opus-4-7' : 'claude-sonnet-4-6'
  const resp = await client.messages.create({
    model,
    max_tokens: 400,
    temperature: 0.4,
    system: DRAFTER_PROMPT,
    messages: [{
      role: 'user',
      content: JSON.stringify({
        first_name: extractFirstName(msg.from_name, msg.from),
        reply_body: msg.body.slice(0, 2000),
        classification: cls.classification,
        intent_signal: cls.intent_signal,
        summary: cls.summary,
      }),
    }],
  })
  return resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim()
}

function extractFirstName(name: string, email: string): string {
  if (name) return name.split(/\s+/)[0] ?? ''
  return (email.split('@')[0] ?? '').split(/[._-]/)[0] ?? ''
}

// =====================================================================
// READ accessors
// =====================================================================

export async function getPendingReplies(limit = 20): Promise<{ pending: number; recent: PendingReply[] }> {
  const list = await kv().lrange<PendingReply>(PENDING_KEY, -limit, -1)
  return {
    pending: list.length,
    recent: list.reverse(),
  }
}
