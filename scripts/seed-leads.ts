#!/usr/bin/env tsx
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// Load .env into process.env (tsx/Node don't auto-load like Nuxt does).
// Skips keys that are already set so Vercel envs / shell overrides still win.
function loadDotEnv(): void {
  const path = join(process.cwd(), '.env')
  if (!existsSync(path)) return
  const text = readFileSync(path, 'utf-8')
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}
loadDotEnv()

/**
 * seed-leads.ts — populate Mimir's lead DB until a target count is reached.
 *
 * Usage:
 *   pnpm seed-leads              # defaults: target=100, base=localhost:3000
 *   pnpm seed-leads 50           # target=50
 *   MIMIR_BASE_URL=https://mimir.vercel.app pnpm seed-leads 100
 *
 * Auth: uses NUXT_CRON_SECRET from .env via the X-Cron-Secret header.
 *
 * What it does:
 *   1. Hits /api/database-stats to see current lead count
 *   2. If under target, hits /api/run-coverage-rotation to run the next
 *      cell (Mimir picks the most-overdue eligible one — guarantees
 *      diversity across cities × niches)
 *   3. Pauses ~5s between cells to avoid Apify burst limits
 *   4. Stops at target OR max-cells (default 40) OR first hard error
 *
 * Run locally — Vercel functions cap at 60-300s per call, and a single cell
 * can take 60-90s. The script handles many sequential calls; running it
 * against a deployed Vercel instance works fine because each /api call is
 * its own (short) request.
 */

const TARGET = parseInt(process.argv[2] ?? '100', 10)
const MAX_CELLS = parseInt(process.env.MIMIR_MAX_CELLS ?? '40', 10)
const PAUSE_MS = parseInt(process.env.MIMIR_PAUSE_MS ?? '5000', 10)
const BASE_URL = (process.env.MIMIR_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')

const CRON_SECRET = process.env.NUXT_CRON_SECRET
if (!CRON_SECRET) {
  console.error('NUXT_CRON_SECRET is not set in .env. Set it before running.')
  process.exit(1)
}

interface DbStats {
  total: number
  by_status: Record<string, number>
  by_city: Record<string, number>
  by_niche: Record<string, number>
  suppressed: number
}

interface CellResult {
  ok: boolean
  cell: { city: string; niche_slug: string }
  found: number
  license_active: number
  license_other: number
  enriched: number
  queued: number
  notes?: string[]
  error?: string
}

async function getStats(): Promise<DbStats> {
  const res = await fetch(`${BASE_URL}/api/database-stats`, {
    headers: { 'X-Cron-Secret': CRON_SECRET! },
  })
  if (!res.ok) throw new Error(`database-stats HTTP ${res.status}: ${await res.text()}`)
  return await res.json() as DbStats
}

async function runOneCell(): Promise<CellResult> {
  const res = await fetch(`${BASE_URL}/api/run-coverage-rotation`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Cron-Secret': CRON_SECRET!,
    },
    body: JSON.stringify({}),  // empty body = auto-pick next eligible
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`run-coverage-rotation HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  return await res.json() as CellResult
}

function pad(n: number, width = 3): string {
  return String(n).padStart(width, ' ')
}

async function main(): Promise<void> {
  console.log(`Mimir seed-leads`)
  console.log(`  target:    ${TARGET} leads`)
  console.log(`  max cells: ${MAX_CELLS}`)
  console.log(`  base URL:  ${BASE_URL}`)
  console.log(`  pause:     ${PAUSE_MS}ms between cells`)
  console.log('')

  const start = Date.now()
  let cellsRun = 0
  let consecutiveEmpty = 0

  // Check starting position
  let stats = await getStats()
  console.log(`Starting: ${stats.total} leads in DB`)
  console.log('')

  while (stats.total < TARGET && cellsRun < MAX_CELLS) {
    cellsRun++

    let result: CellResult
    try {
      result = await runOneCell()
    } catch (err) {
      console.error(`[${pad(cellsRun)}] HTTP error: ${err instanceof Error ? err.message : 'unknown'}`)
      console.error('Stopping. Run again after fixing the issue.')
      break
    }

    const cellLabel = `${result.cell.city} × ${result.cell.niche_slug}`.padEnd(40)
    if (!result.ok) {
      console.log(`[${pad(cellsRun)}] ${cellLabel}  ✗ ${result.error}`)
      console.log('  Cell run failed. Stopping.')
      break
    }

    const summary = `found ${pad(result.found, 2)} · license ${pad(result.license_active, 2)} · enriched ${pad(result.enriched, 2)} · would-queue ${pad(result.queued, 2)}`
    console.log(`[${pad(cellsRun)}] ${cellLabel}  ${summary}`)

    if (result.found === 0) {
      consecutiveEmpty++
      if (consecutiveEmpty >= 3) {
        console.log('  3 cells in a row returned 0 leads — Apify may be rate-limiting or all cells exhausted. Stopping.')
        break
      }
    } else {
      consecutiveEmpty = 0
    }

    // Pause between cells to be kind to Apify
    if (cellsRun < MAX_CELLS) {
      await new Promise(r => setTimeout(r, PAUSE_MS))
    }

    stats = await getStats()
  }

  const elapsed = Math.round((Date.now() - start) / 1000)
  console.log('')
  console.log(`Done. ${cellsRun} cells run in ${elapsed}s.`)
  console.log(`Final lead count: ${stats.total}`)
  console.log('')
  console.log('Breakdown by city:')
  for (const [city, count] of Object.entries(stats.by_city).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${city.padEnd(20)} ${count}`)
  }
  console.log('')
  console.log('Breakdown by niche:')
  for (const [niche, count] of Object.entries(stats.by_niche).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${niche.padEnd(30)} ${count}`)
  }
  console.log('')
  console.log('Next steps:')
  console.log('  1. Open /markets in your browser to see the coverage heatmap')
  console.log('  2. Ask Mimir "show me the top leads" to see quality-ranked results')
  console.log('  3. Pick 2-3 to test the queue flow end-to-end')
}

void main().catch(err => {
  console.error('seed-leads failed:', err)
  process.exit(1)
})
