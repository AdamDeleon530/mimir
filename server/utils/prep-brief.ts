/**
 * Pre-call brief generator.
 *
 * For every meeting in the next ~24h, generate a 1-page brief Adam can read
 * with coffee before the call. The brief covers who they are, what their
 * digital presence looks like, three concrete weaknesses to lead with, the
 * suggested tier ($1.5K / $2K / $2.5K), and three talking points.
 *
 * Stored in KV at mimir:briefs:<meeting_id>. The morning briefing surfaces
 * tomorrow's briefs at the top so Adam sees them before the day starts.
 */
import Anthropic from '@anthropic-ai/sdk'
import { kv } from './kv'
import { recordAnthropicUsage } from './cost-tracker'
import { meetingsNeedingBriefs, attachBrief, type Meeting } from './meetings'
import { getLead, getInteractions, normalizeDomain } from './lead-db'
import { scrapeWebsite } from './lead-tools'

const BRIEF_KEY = (meetingId: string) => `mimir:briefs:${meetingId}`
const BRIEF_TTL = 60 * 60 * 24 * 14  // keep two weeks

export interface PrepBrief {
  meeting_id: string
  generated_at: string
  attendee_name: string
  attendee_email: string
  attendee_company: string
  lead_domain?: string
  start_time: string
  duration_min: number
  // The body — plain prose, three paragraphs at most
  body: string
  // Structured "what to lead with" surface
  three_weaknesses: string[]
  suggested_tier: 'Starter' | 'Growth' | 'Authority' | 'unknown'
  suggested_price: number
  talking_points: string[]
  // Provenance — what we knew at generation time
  facts: Record<string, unknown>
  tokens_used?: { input: number; output: number }
}

const SYSTEM_PROMPT = `You are Mimir writing a pre-call brief for Adam.

The brief is the FIRST thing Adam reads when he sits down for a call with a contractor prospect. It tells him in 90 seconds what to lead with.

OUTPUT — JSON object only, no prose around it. Schema:
{
  "body": "<one-paragraph dry summary of who they are and the dynamic going in, 60-100 words>",
  "three_weaknesses": [
    "<single sentence — a specific, concrete weakness in their digital presence Adam can lead with>",
    "<second weakness>",
    "<third weakness>"
  ],
  "suggested_tier": "Starter" | "Growth" | "Authority",
  "talking_points": [
    "<single sentence — a talking point that demonstrates expertise>",
    "<second>",
    "<third>"
  ]
}

VOICE for body + talking points: dry, calm, technical, peer-to-peer. No "leverage" or "solutions". Periods are weapons. The contractor is a peer who knows their trade better than you know yours.

TIER GUIDANCE:
- Starter $1,500/mo — small shop, owner-operator, GBP score 3-5, basic needs
- Growth $2,000/mo — 5-20 employees, GBP score 4-7, ready for more
- Authority $2,500/mo — 20+ employees, multi-truck, GBP score 6-7 (room to dominate)
Pick based on review_count, photo_count, hiring_signal, license_tenure.

WEAKNESSES should be GROUNDED in the facts you're given. Never invent. If a contractor has a Facebook-only presence, that's a weakness; if their GBP has 200 photos and 4.9 stars, don't claim photos as a weakness — find a real one.

If facts are too thin to write three real weaknesses, write fewer (one or two), and note in the body that you'd want Adam to look at their site briefly before the call.`

export interface GenerateBriefResult {
  generated: number
  failed: number
  briefs: Array<{ meeting_id: string; ok: boolean; error?: string }>
}

export async function generateBriefsForUpcoming(): Promise<GenerateBriefResult> {
  const meetings = await meetingsNeedingBriefs()
  const out: GenerateBriefResult = { generated: 0, failed: 0, briefs: [] }
  for (const m of meetings) {
    const r = await generateBriefForMeeting(m)
    if (r.ok) out.generated++
    else out.failed++
    out.briefs.push({ meeting_id: m.id, ok: r.ok, ...(r.error ? { error: r.error } : {}) })
  }
  return out
}

export async function generateBriefForMeeting(meeting: Meeting): Promise<{ ok: boolean; brief?: PrepBrief; error?: string }> {
  const anthropicKey = process.env.NUXT_ANTHROPIC_API_KEY
  if (!anthropicKey) return { ok: false, error: 'NUXT_ANTHROPIC_API_KEY not set' }

  // Pull every fact we have on this lead
  const facts: Record<string, unknown> = {
    attendee_name: meeting.attendee_name,
    attendee_email: meeting.attendee_email,
    attendee_company: meeting.attendee_company,
    meeting_start: meeting.start_time,
    meeting_duration_min: meeting.duration_min,
  }

  let leadDomain = meeting.lead_domain
  if (!leadDomain) {
    // Try guessing from email
    const emailDomain = normalizeDomain((meeting.attendee_email.split('@')[1] ?? ''))
    if (emailDomain && !COMMON_FREE_DOMAINS.has(emailDomain)) leadDomain = emailDomain
  }

  if (leadDomain) {
    const lead = await getLead(leadDomain)
    if (lead) {
      facts.lead = {
        domain: lead.domain,
        business_name: lead.business_name,
        city: lead.city,
        niche: lead.niche,
        category: lead.category,
        gbp_score: lead.gbp_score,
        rating: lead.rating,
        reviews_count: lead.reviews_count,
        photo_count: lead.photo_count,
        website: lead.website,
        phone: lead.phone,
        license: lead.license,
        decision_maker: lead.decision_maker,
        signals: lead.signals,
        quality: lead.quality,
        status: lead.status,
      }
      facts.recent_interactions = (await getInteractions(leadDomain, 8)).map(i => ({
        at: i.at, type: i.type, source: i.source, details: i.details,
      }))
    }
  }

  // Live website peek — Mimir's eyes on the prospect's site, captured now
  if (leadDomain) {
    try {
      const scrape = await scrapeWebsite(leadDomain)
      if (scrape.ok) {
        facts.live_site = {
          page_title: scrape.page_title,
          meta_description: scrape.meta_description,
          emails_visible: scrape.emails,
          phones_visible: scrape.phones,
          social_links: scrape.social_links,
          text_excerpt: scrape.text_excerpt.slice(0, 800),
        }
      }
    } catch { /* scrape is best-effort */ }
  }

  const client = new Anthropic({ apiKey: anthropicKey })
  let raw: Anthropic.Message
  try {
    raw = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      temperature: 0.4,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(facts) }],
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'anthropic call failed' }
  }

  // Cost log
  try {
    await recordAnthropicUsage({
      model: 'claude-sonnet-4-6',
      input_tokens: raw.usage.input_tokens,
      output_tokens: raw.usage.output_tokens,
      caller: 'prep_brief',
    })
  } catch { /* swallow */ }

  const text = raw.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim()

  // Parse the JSON — model occasionally wraps in code fence, strip it
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
  interface Parsed {
    body: string
    three_weaknesses: string[]
    suggested_tier: 'Starter' | 'Growth' | 'Authority'
    talking_points: string[]
  }
  let parsed: Parsed
  try {
    parsed = JSON.parse(cleaned) as Parsed
  } catch {
    return { ok: false, error: `JSON parse failed. Raw: ${cleaned.slice(0, 200)}` }
  }

  const tierPriceMap = { Starter: 1500, Growth: 2000, Authority: 2500 } as const
  const brief: PrepBrief = {
    meeting_id: meeting.id,
    generated_at: new Date().toISOString(),
    attendee_name: meeting.attendee_name,
    attendee_email: meeting.attendee_email,
    attendee_company: meeting.attendee_company ?? '',
    ...(leadDomain ? { lead_domain: leadDomain } : {}),
    start_time: meeting.start_time,
    duration_min: meeting.duration_min,
    body: parsed.body ?? '',
    three_weaknesses: Array.isArray(parsed.three_weaknesses) ? parsed.three_weaknesses.slice(0, 3) : [],
    suggested_tier: parsed.suggested_tier ?? 'unknown',
    suggested_price: tierPriceMap[parsed.suggested_tier] ?? 0,
    talking_points: Array.isArray(parsed.talking_points) ? parsed.talking_points.slice(0, 3) : [],
    facts,
    tokens_used: {
      input: raw.usage.input_tokens,
      output: raw.usage.output_tokens,
    },
  }

  await kv().set(BRIEF_KEY(meeting.id), brief, BRIEF_TTL)
  await attachBrief(meeting.id, BRIEF_KEY(meeting.id))

  return { ok: true, brief }
}

export async function getBrief(meetingId: string): Promise<PrepBrief | null> {
  return kv().get<PrepBrief>(BRIEF_KEY(meetingId))
}

// Free email domains we should NOT treat as lead domains
const COMMON_FREE_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'me.com', 'msn.com', 'live.com', 'ymail.com',
])
