/**
 * Daily briefing generator.
 *
 * Pulls real numbers from the queue + the existing live-data sources, hands
 * Mimir a brief-writer prompt, and stores the result in KV under
 * mimir:briefings as an append-only list. /briefings page reads it.
 */
import Anthropic from '@anthropic-ai/sdk'
import { kv } from './kv'
import { getQueueStatus } from './sequence-state'
import { inboxStatus, inboxesConfigured } from './email-sender'
import { opsSyncStatus } from './ops-context'

const BRIEFINGS_KEY = 'mimir:briefings'
const MAX_BRIEFINGS_KEPT = 60  // ~3 months of weekday briefings

export interface Briefing {
  id: string                  // YYYY-MM-DD-HHMM
  generated_at: string
  date_local: string          // e.g. "Friday, June 5"
  body: string                // Mimir's prose
  facts: {
    queue: Awaited<ReturnType<typeof getQueueStatus>>
    inboxes: Awaited<ReturnType<typeof inboxStatus>>
    ops_files: number
    ops_synced_at: string
  }
  tokens_used?: { input: number; output: number }
}

const BRIEFING_SYSTEM_PROMPT = `You are Mimir writing Adam's daily briefing.

Adam will read this with coffee. It opens his workday on The Nordic Nerd. He is in month one of a twelve-month goal to replace W2 income with the agency.

WRITE in your usual voice: dry, calm, short. Periods are weapons. Lead with numbers. No "good morning" energy. Norse imagery once or never.

STRUCTURE — exactly three short paragraphs:
1. The numbers — money / queue / inboxes — facts in sentence form, no lists
2. The watch — what's likely happening today (sends going out, capacity headroom, anything stale)
3. One suggestion — a single concrete action Adam could take today. Cap at one sentence.

LENGTH: 80-160 words total. Brevity is respect.

DO NOT:
- Use "Good morning" or any greeting
- Use exclamation marks or emoji
- Invent numbers — only use what you're given
- Pad with platitudes
- Suggest more than one action

Output PLAIN PROSE. No markdown, no headers, no lists. The briefing will be read in a UI panel and spoken aloud.`

export async function generateBriefing(): Promise<{ ok: true; briefing: Briefing } | { ok: false; error: string }> {
  const anthropicKey = process.env.NUXT_ANTHROPIC_API_KEY
  if (!anthropicKey) return { ok: false, error: 'NUXT_ANTHROPIC_API_KEY not set' }

  const [queue, inboxes] = await Promise.all([
    getQueueStatus(),
    inboxStatus(),
  ])
  const ops = opsSyncStatus()

  // Compose the user message with structured facts the model can read.
  const facts = {
    today_local: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
    inboxes_configured: inboxesConfigured(),
    queue,
    inboxes,
    ops_files: ops.fileCount,
    ops_synced_at: ops.syncedAt,
  }

  const client = new Anthropic({ apiKey: anthropicKey })

  let body = ''
  let tokensUsed: { input: number; output: number } | undefined
  try {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      temperature: 0.4,
      system: BRIEFING_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Write today's briefing. Facts:\n${JSON.stringify(facts, null, 2)}`,
      }],
    })
    body = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim()
    tokensUsed = {
      input: resp.usage.input_tokens,
      output: resp.usage.output_tokens,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'briefing generation failed' }
  }

  const now = new Date()
  const id = now.toISOString().slice(0, 16).replace(/[:-]/g, '').replace('T', '-')
  const briefing: Briefing = {
    id,
    generated_at: now.toISOString(),
    date_local: facts.today_local,
    body,
    facts: { queue, inboxes, ops_files: ops.fileCount, ops_synced_at: ops.syncedAt },
    tokens_used: tokensUsed,
  }

  // Append + trim to MAX_BRIEFINGS_KEPT
  await kv().rpush(BRIEFINGS_KEY, briefing)
  await kv().ltrim(BRIEFINGS_KEY, -MAX_BRIEFINGS_KEPT, -1)

  return { ok: true, briefing }
}

export async function recentBriefings(limit = 14): Promise<Briefing[]> {
  const list = await kv().lrange<Briefing>(BRIEFINGS_KEY, -limit, -1)
  // newest first
  return list.reverse()
}

export async function latestBriefing(): Promise<Briefing | null> {
  const list = await kv().lrange<Briefing>(BRIEFINGS_KEY, -1, -1)
  return list[0] ?? null
}
