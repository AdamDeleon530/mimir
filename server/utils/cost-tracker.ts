/**
 * Cost tracker — logs every Anthropic call to KV and enforces a daily cap.
 *
 * Pricing constants are kept inline (per-million-token rates). Update when
 * Anthropic publishes new pricing. We round costs in micro-dollars to keep
 * integer-friendly INCRBY semantics in KV.
 */
import { kv } from './kv'

const DEFAULT_DAILY_BUDGET_USD = Number(process.env.NUXT_DAILY_BUDGET_USD ?? '5')

interface Pricing { input: number; output: number }  // USD per million tokens

const PRICING: Record<string, Pricing> = {
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4 },
}

function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? PRICING['claude-sonnet-4-6']
  if (!p) return 0
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output
}

function dayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10)
}

interface LogEntry {
  at: string
  model: string
  input_tokens: number
  output_tokens: number
  usd: number
  caller: string
}

export interface DailySpend {
  date: string
  total_usd: number
  total_input_tokens: number
  total_output_tokens: number
  call_count: number
  by_model: Record<string, { calls: number; usd: number }>
}

const LOG_LIST_KEY = (day: string) => `mimir:cost:log:${day}`
const SUMMARY_KEY = (day: string) => `mimir:cost:summary:${day}`
const MAX_LOG_ENTRIES_KEPT = 500

/**
 * Record a single Anthropic call. Call this AFTER the API call returns
 * with the real usage numbers.
 */
export async function recordAnthropicUsage(opts: {
  model: string
  input_tokens: number
  output_tokens: number
  caller: string
}): Promise<{ usd: number }> {
  const usd = costUsd(opts.model, opts.input_tokens, opts.output_tokens)
  const day = dayKey()
  const entry: LogEntry = {
    at: new Date().toISOString(),
    model: opts.model,
    input_tokens: opts.input_tokens,
    output_tokens: opts.output_tokens,
    usd,
    caller: opts.caller,
  }

  // Append to log (capped) and update the summary structure
  await kv().rpush(LOG_LIST_KEY(day), entry)
  await kv().ltrim(LOG_LIST_KEY(day), -MAX_LOG_ENTRIES_KEPT, -1)

  const existing = (await kv().get<DailySpend>(SUMMARY_KEY(day))) ?? {
    date: day,
    total_usd: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    call_count: 0,
    by_model: {},
  }
  existing.total_usd += usd
  existing.total_input_tokens += opts.input_tokens
  existing.total_output_tokens += opts.output_tokens
  existing.call_count += 1
  const mm = existing.by_model[opts.model] ?? { calls: 0, usd: 0 }
  mm.calls += 1
  mm.usd += usd
  existing.by_model[opts.model] = mm
  await kv().set(SUMMARY_KEY(day), existing, 60 * 60 * 24 * 31)  // keep 31 days

  return { usd }
}

export async function dailySpend(day = dayKey()): Promise<DailySpend> {
  const s = await kv().get<DailySpend>(SUMMARY_KEY(day))
  return s ?? {
    date: day,
    total_usd: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    call_count: 0,
    by_model: {},
  }
}

export interface BudgetCheck {
  allowed: boolean
  remaining_usd: number
  cap_usd: number
  spent_usd: number
  at_warning_threshold: boolean  // true once we cross 80% of cap
  reason?: string
}

/**
 * Check before a chat turn whether we're under the daily cap.
 * Returns allowed=false when over cap. The /api/chat handler can return
 * a polite "Mimir says we're at the budget cap" response instead of calling.
 */
export async function checkDailyBudget(): Promise<BudgetCheck> {
  const cap = DEFAULT_DAILY_BUDGET_USD
  const spend = await dailySpend()
  const remaining = cap - spend.total_usd
  const atWarning = spend.total_usd >= cap * 0.8
  if (remaining <= 0) {
    return {
      allowed: false,
      remaining_usd: 0,
      cap_usd: cap,
      spent_usd: spend.total_usd,
      at_warning_threshold: true,
      reason: `Daily Anthropic budget cap of $${cap.toFixed(2)} reached. Spent $${spend.total_usd.toFixed(3)}.`,
    }
  }
  return {
    allowed: true,
    remaining_usd: remaining,
    cap_usd: cap,
    spent_usd: spend.total_usd,
    at_warning_threshold: atWarning,
  }
}
