/**
 * A/B testing — subject-line variant pool with per-cell performance tracking.
 *
 * Architecture:
 *   - Variant pool stored in KV at mimir:ab:variants (keyed by step number)
 *   - On send, the email-sender picks a variant via weighted random (Thompson-
 *     sampling-lite — variants with higher positive-reply rate get picked more
 *     often, with a small exploration bonus for under-tested variants)
 *   - Per-send variant assignment stored at mimir:ab:assignments:<email>
 *   - On reply received, the reply-ingester looks up the assignment and
 *     credits the variant
 *   - Results aggregated per (cell, variant) tuple in mimir:ab:results
 *
 * MVP: subject-line A/B for email step 1. Body + CTA variants pluggable later.
 */
import { kv } from './kv'

// =====================================================================
// VARIANT POOL
// =====================================================================

export interface Variant {
  id: string                  // e.g. "v_lakeland_default"
  step: number                // which email step (1-4) this applies to
  subject: string             // the subject line to use
  description?: string        // optional human note
  enabled: boolean
}

const VARIANTS_KEY = 'mimir:ab:variants'

// Initial pool drawn from the subject-line bank in the ops library.
// Adam can add/remove via tools. Each step has at least a "default" variant
// matching the existing sequence-templates.ts so behaviour is unchanged
// until Adam adds alternatives.
const SEED_VARIANTS: Variant[] = [
  { id: 'v1_default',     step: 1, subject: 'saw your {{city}} site',                          enabled: true,  description: 'baseline — short observation' },
  { id: 'v1_question',    step: 1, subject: 'quick {{niche}} question',                         enabled: false, description: 'curiosity opener' },
  { id: 'v1_specific',    step: 1, subject: 'three things on {{company_name}}\'s GBP',         enabled: false, description: 'tangible audit hook' },
  { id: 'v2_default',     step: 2, subject: 're: {{city}}',                                     enabled: true,  description: 'baseline reply-style' },
  { id: 'v3_default',     step: 3, subject: 'one specific thing',                               enabled: true,  description: 'baseline soft nudge' },
  { id: 'v4_default',     step: 4, subject: 'last note',                                        enabled: true,  description: 'baseline final email' },
]

async function loadVariants(): Promise<Variant[]> {
  const stored = await kv().get<Variant[]>(VARIANTS_KEY)
  if (Array.isArray(stored) && stored.length > 0) return stored
  // Seed on first read
  await kv().set(VARIANTS_KEY, SEED_VARIANTS)
  return SEED_VARIANTS
}

async function saveVariants(v: Variant[]): Promise<void> {
  await kv().set(VARIANTS_KEY, v)
}

export async function listVariants(step?: number): Promise<Variant[]> {
  const all = await loadVariants()
  return typeof step === 'number' ? all.filter(v => v.step === step) : all
}

export async function addVariant(input: { step: number; subject: string; description?: string; enabled?: boolean }): Promise<Variant> {
  const all = await loadVariants()
  const id = `v${input.step}_${slug(input.subject).slice(0, 24)}_${Math.floor(Date.now() / 1000)}`
  const variant: Variant = {
    id,
    step: input.step,
    subject: input.subject,
    ...(input.description ? { description: input.description } : {}),
    enabled: input.enabled ?? true,
  }
  all.push(variant)
  await saveVariants(all)
  return variant
}

export async function setVariantEnabled(id: string, enabled: boolean): Promise<boolean> {
  const all = await loadVariants()
  const target = all.find(v => v.id === id)
  if (!target) return false
  target.enabled = enabled
  await saveVariants(all)
  return true
}

// =====================================================================
// VARIANT PICKING (weighted by performance)
// =====================================================================

interface VariantStats {
  sent: number
  replied: number
  replied_positive: number
}

const RESULTS_KEY = 'mimir:ab:results'   // map of `${cell_key}|${variant_id}` → VariantStats

interface ResultsMap { [key: string]: VariantStats }

async function loadResults(): Promise<ResultsMap> {
  const r = await kv().get<ResultsMap>(RESULTS_KEY)
  return (r && typeof r === 'object') ? r : {}
}

async function saveResults(r: ResultsMap): Promise<void> {
  await kv().set(RESULTS_KEY, r)
}

function cellKey(city: string, niche: string): string {
  return `${city.toLowerCase()}|${niche.toLowerCase()}`
}

/**
 * Pick a variant for a given step + cell. Weighted random by current positive-
 * reply rate, with smoothing so an untested variant still has nonzero weight.
 * Beta(1,1) prior — every variant starts at 1/1 (50% perceived rate) and
 * gradually converges to its real rate as data accumulates.
 */
export async function pickVariantForSend(step: number, city: string, niche: string): Promise<Variant | null> {
  const all = await loadVariants()
  const enabled = all.filter(v => v.step === step && v.enabled)
  if (enabled.length === 0) return null
  if (enabled.length === 1) return enabled[0]!

  const results = await loadResults()
  const ck = cellKey(city, niche)

  // Beta-style weighting: each variant has (positive + 1) successes and
  // (sent - positive + 1) failures. Sample a "perceived rate" from this
  // beta, then pick the highest sample (Thompson sampling).
  const sampled = enabled.map(v => {
    const stats = results[`${ck}|${v.id}`] ?? { sent: 0, replied: 0, replied_positive: 0 }
    const alpha = stats.replied_positive + 1
    const beta = Math.max(0, stats.sent - stats.replied_positive) + 1
    const sample = sampleBeta(alpha, beta)
    return { variant: v, sample }
  })
  sampled.sort((a, b) => b.sample - a.sample)
  return sampled[0]!.variant
}

/**
 * Simple beta sampler using the gamma-of-uniforms trick. Doesn't need a math
 * library; precision is good enough for variant selection.
 */
function sampleBeta(alpha: number, beta: number): number {
  // For small alpha/beta, use rejection. For larger, gamma ratios.
  const g1 = sampleGamma(alpha)
  const g2 = sampleGamma(beta)
  return g1 / (g1 + g2)
}

function sampleGamma(shape: number): number {
  // Marsaglia & Tsang's method (good for shape >= 1)
  if (shape < 1) return sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape)
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  while (true) {
    let x = 0
    let v = 0
    do { x = boxMuller(); v = 1 + c * x } while (v <= 0)
    v = v * v * v
    const u = Math.random()
    if (u < 1 - 0.0331 * x * x * x * x) return d * v
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}

function boxMuller(): number {
  let u = 0, v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// =====================================================================
// ASSIGNMENT TRACKING
// =====================================================================
//
// We need to remember which variant each lead got at each step so when a
// reply comes in days later we can credit the right variant.

const ASSIGNMENT_KEY = (email: string, step: number) => `mimir:ab:assign:${email.toLowerCase()}:${step}`

export async function recordVariantAssignment(opts: {
  email: string
  step: number
  variant_id: string
  city: string
  niche: string
}): Promise<void> {
  await kv().set(
    ASSIGNMENT_KEY(opts.email, opts.step),
    { variant_id: opts.variant_id, city: opts.city, niche: opts.niche, at: new Date().toISOString() },
    // Hold for 60 days (covers full sequence + reply window)
    60 * 24 * 3600,
  )
  // Also bump the sent counter
  const results = await loadResults()
  const ck = cellKey(opts.city, opts.niche)
  const k = `${ck}|${opts.variant_id}`
  const cur = results[k] ?? { sent: 0, replied: 0, replied_positive: 0 }
  cur.sent += 1
  results[k] = cur
  await saveResults(results)
}

export interface AssignmentLookup {
  variant_id: string
  city: string
  niche: string
  at: string
}

export async function getAssignment(email: string, step: number): Promise<AssignmentLookup | null> {
  return kv().get<AssignmentLookup>(ASSIGNMENT_KEY(email, step))
}

/**
 * Called by the reply-ingester when a reply comes in. Credits the variant
 * for both the email and (in the worst case) any step we sent — we don't know
 * which specific email triggered the reply, but we can credit the most recent
 * step's variant.
 */
export async function creditReplyToVariant(opts: {
  email: string
  classification: 'positive' | 'question' | 'objection' | 'unsubscribe' | 'ooo' | 'negative' | 'other'
}): Promise<{ credited: boolean; variant_id?: string }> {
  // Try steps 4 → 1; credit the most recent send
  for (let step = 4; step >= 1; step--) {
    const a = await getAssignment(opts.email, step)
    if (!a) continue
    const results = await loadResults()
    const k = `${cellKey(a.city, a.niche)}|${a.variant_id}`
    const cur = results[k] ?? { sent: 0, replied: 0, replied_positive: 0 }
    if (opts.classification !== 'ooo' && opts.classification !== 'other') {
      cur.replied += 1
    }
    if (opts.classification === 'positive') {
      cur.replied_positive += 1
    }
    results[k] = cur
    await saveResults(results)
    return { credited: true, variant_id: a.variant_id }
  }
  return { credited: false }
}

// =====================================================================
// REPORTING
// =====================================================================

export interface AbReportRow {
  cell_key: string
  city: string
  niche: string
  variant_id: string
  subject: string
  step: number
  sent: number
  replied: number
  replied_positive: number
  reply_rate: number
  positive_rate: number
}

export async function abResults(filter?: { city?: string; niche?: string }): Promise<AbReportRow[]> {
  const variants = await loadVariants()
  const variantById = new Map(variants.map(v => [v.id, v]))
  const results = await loadResults()
  const out: AbReportRow[] = []
  for (const [key, stats] of Object.entries(results)) {
    const [cellPart, variant_id] = key.split('|', 2)
    if (!cellPart || !variant_id) continue
    const v = variantById.get(variant_id)
    if (!v) continue
    const [city, niche] = cellPart.split('|')
    if (filter?.city && city?.toLowerCase() !== filter.city.toLowerCase()) continue
    if (filter?.niche && niche?.toLowerCase() !== filter.niche.toLowerCase()) continue
    out.push({
      cell_key: cellPart,
      city: city ?? '',
      niche: niche ?? '',
      variant_id,
      subject: v.subject,
      step: v.step,
      sent: stats.sent,
      replied: stats.replied,
      replied_positive: stats.replied_positive,
      reply_rate: stats.sent === 0 ? 0 : Math.round((stats.replied / stats.sent) * 1000) / 10,
      positive_rate: stats.sent === 0 ? 0 : Math.round((stats.replied_positive / stats.sent) * 1000) / 10,
    })
  }
  // Best positive-rate first
  out.sort((a, b) => b.positive_rate - a.positive_rate)
  return out
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}
