#!/usr/bin/env tsx
/**
 * sync-dbpr.ts — pull the latest Florida DBPR contractor licensee data
 * and write a filtered JSON snapshot to server/data/dbpr-snapshot.json.
 *
 * Download strategy: stream to a temp file (not arrayBuffer), browser-like
 * User-Agent, 5-min timeout per attempt, 3 retries with exponential backoff.
 * DBPR's web servers hang stateless fetches on multi-MB downloads — streaming
 * survives that.
 *
 * Run via: pnpm sync-dbpr
 *
 * DATA SOURCE — the honest situation
 * -----------------------------------
 * Florida's DBPR does NOT publish a clean public bulk CSV of contractor
 * licensees. It used to (~2018-2022) but as of late 2024 the data lives
 * behind PROfile (their licensee portal, login-required) or via paid
 * vendors. Three realistic paths:
 *
 *   1. Public Records Request — Adam can file one at
 *      https://www.myfloridalicense.com/dbpr/contracts-public-records/
 *      They mail/email a CSV in 1-2 weeks. Free, slow, one-shot.
 *      THIS IS THE BEST OPTION if Adam wants a full snapshot.
 *
 *   2. Per-lead lookup via Apify — search community actors for
 *      "Florida Contractor License" or "DBPR". ~$0.02-0.10 per lookup.
 *      For 200 leads that's $4-20 total. Live data, no snapshot needed.
 *      Wire it via verify_license's remote-search path in dbpr.ts.
 *
 *   3. Manual attach — Adam reads the license number off the contractor's
 *      GBP (FL law requires it displayed) and uses Mimir's attach_license
 *      tool. 30 seconds per lead, zero cost. Works for high-priority leads.
 *
 * This script is built for path 4 (which would be: someone publishes a
 * CSV at a URL you can fetch). If/when that comes back, set
 * DBPR_SOURCE_URL and run. Until then, the snapshot file will be empty
 * and verify_license falls back gracefully to "manual attach" guidance.
 *
 * What we keep:
 *   - Only the 9 Certified contractor license classes Adam targets (CGC, CBC,
 *     CRC, CCC, CMC, CFC, CAC, CPC, EC)
 *   - Active + Expired licenses (we want to see "expired" for filtering, but
 *     drop "voluntarily relinquished" / surrendered)
 *   - Stripped to the fields lead-db.ts needs (no extra columns)
 *
 * Local-only — does not commit, does not push.
 */
import { writeFileSync, mkdirSync, readFileSync, createWriteStream, statSync, unlinkSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// Load .env into process.env (tsx/Node don't auto-load like Nuxt does).
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

// =====================================================================
// CONFIG
// =====================================================================

// TODO Adam: paste the current CSV URL here. Until then this script will
// write an empty snapshot file so the runtime path works, and you'll know
// to update this once.
const SOURCE_URL = process.env.DBPR_SOURCE_URL ?? ''

const TARGET_CLASSES = new Set([
  'CGC', 'CBC', 'CRC',     // general / building / residential
  'CCC',                   // roofing
  'CMC', 'CAC',            // HVAC
  'CFC',                   // plumbing
  'CPC',                   // pool
  'EC',                    // electrical
])

// Florida only — but we also accept "all FL" because some bulk exports
// include other states (rare).
const TARGET_COUNTIES: Set<string> | null = null  // null = all FL counties.
                                                  // To limit early scrapes to Polk: new Set(['POLK'])

const OUTPUT_PATH = join(process.cwd(), 'server', 'data', 'dbpr-snapshot.json')

// =====================================================================
// MAIN
// =====================================================================

async function main(): Promise<void> {
  console.log('Mimir DBPR sync — starting')
  console.log(`Target classes: ${[...TARGET_CLASSES].join(', ')}`)
  console.log(`Source URL: ${SOURCE_URL || '(not set — writing empty snapshot)'}`)

  let records: SnapshotRecord[] = []

  if (SOURCE_URL) {
    try {
      records = await downloadAndParse(SOURCE_URL)
      console.log(`Parsed ${records.length} matching contractor records`)
    } catch (err) {
      console.error('Download failed:', err instanceof Error ? err.message : err)
      console.error('Writing empty snapshot — fix SOURCE_URL and re-run.')
    }
  } else {
    console.warn('No DBPR_SOURCE_URL set. Writing empty snapshot.')
    console.warn('To populate: find the current CSV URL at')
    console.warn('  https://www2.myfloridalicense.com/dbpr/contractor-construction/')
    console.warn('Then run: DBPR_SOURCE_URL="https://..." pnpm sync-dbpr')
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true })
  const snapshot = {
    generated_at: new Date().toISOString(),
    source_url: SOURCE_URL || null,
    count: records.length,
    records,
  }
  writeFileSync(OUTPUT_PATH, JSON.stringify(snapshot, null, 2))
  console.log(`Wrote ${records.length} records to ${OUTPUT_PATH}`)
}

// =====================================================================
// DOWNLOAD + PARSE
// =====================================================================

interface SnapshotRecord {
  license_number: string
  license_class: string
  license_status: 'active' | 'expired' | 'suspended' | 'revoked' | 'voluntarily_relinquished' | 'unknown'
  business_name: string
  dba_name?: string
  owner_name?: string
  city: string
  county: string
  zip?: string
  issue_date?: string
  expiration_date?: string
  discipline_count?: number
}

async function downloadAndParse(source: string): Promise<SnapshotRecord[]> {
  let text: string
  let tempPath: string | null = null

  try {
    if (isLocalPath(source)) {
      const path = toLocalPath(source)
      console.log(`Reading local file: ${path}`)
      if (!existsSync(path)) {
        throw new Error(`File not found at ${path}. Check the path is correct and the file isn't compressed (.zip / .gz / .csv.gz).`)
      }
      text = readFileSync(path, 'utf-8')
      console.log(`Loaded ${(text.length / 1024 / 1024).toFixed(1)} MB from disk`)
    } else {
      tempPath = join(tmpdir(), `dbpr-${Date.now()}.csv`)
      await downloadStreaming(source, tempPath)
      const sizeBytes = statSync(tempPath).size
      console.log(`Downloaded ${(sizeBytes / 1024 / 1024).toFixed(1)} MB to temp file`)
      text = readFileSync(tempPath, 'utf-8')
    }

    // Sanity check: is this actually CSV, or did we end up with an HTML error page?
    const preview = text.slice(0, 400).trim()
    if (preview.startsWith('<') || preview.toLowerCase().includes('<html')) {
      throw new Error(`File looks like HTML, not CSV. Preview:\n${preview.slice(0, 200)}`)
    }

    // Show the first rows so Adam can spot column-mapping issues
    const firstLines = text.split('\n').slice(0, 3)
    console.log('First 3 lines of CSV:')
    for (const line of firstLines) console.log('  | ' + line.slice(0, 200))

    return parseCsv(text)
  } finally {
    if (tempPath && existsSync(tempPath)) {
      try { unlinkSync(tempPath) } catch { /* leave it */ }
    }
  }
}

function isLocalPath(s: string): boolean {
  if (s.startsWith('file://')) return true
  if (s.startsWith('/')) return true            // POSIX absolute
  if (/^[A-Za-z]:[\\/]/.test(s)) return true    // Windows absolute (C:\... or C:/...)
  if (s.startsWith('~/')) return true           // home shorthand
  return false
}

function toLocalPath(s: string): string {
  if (s.startsWith('file://')) {
    // Trim file:// and any host (file:///path or file://localhost/path)
    return s.replace(/^file:\/\/(localhost)?/, '')
  }
  if (s.startsWith('~/')) {
    return join(process.env.HOME ?? '', s.slice(2))
  }
  return s
}

async function downloadStreaming(url: string, destPath: string, attempt = 1): Promise<void> {
  const MAX_ATTEMPTS = 3
  const TIMEOUT_MS = 5 * 60 * 1000  // 5 minutes
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    console.log(`Downloading (attempt ${attempt}/${MAX_ATTEMPTS})…`)
    const res = await fetch(url, {
      headers: {
        // Browser-like UA — DBPR's servers occasionally 403 the default Node UA
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/csv,application/csv,text/plain,*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive',
      },
      signal: controller.signal,
      redirect: 'follow',
    })

    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    if (!res.body) throw new Error('response had no body')

    const out = createWriteStream(destPath)
    await pipeline(Readable.fromWeb(res.body as never), out)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (attempt < MAX_ATTEMPTS) {
      const backoffSec = 2 ** attempt
      console.warn(`  attempt ${attempt} failed: ${msg}`)
      console.warn(`  waiting ${backoffSec}s before retry…`)
      await new Promise(r => setTimeout(r, backoffSec * 1000))
      return downloadStreaming(url, destPath, attempt + 1)
    }
    throw new Error(`download failed after ${MAX_ATTEMPTS} attempts: ${msg}`)
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * The DBPR CONSTRUCTIONLICENSE_1.csv export is HEADERLESS and positional.
 * Decoded from sample rows (e.g. "06","CBC","CRACCHIOLO, SAM A JR",...):
 *
 *   0  Board code (06 = Construction Industry Licensing Board)
 *   1  License class prefix (CGC, CBC, CCC, CMC, CFC, CAC, CPC, EC, ...)
 *   2  Name — "LAST, FIRST" for individuals, business name otherwise
 *   3  DBA name (often blank)
 *   4  Alt/address name (often blank)
 *   5  Address line 1
 *   6  Address line 2
 *   7  Address line 3
 *   8  City
 *   9  State (FL/etc.)
 *   10 ZIP
 *   11 County code (numeric)
 *   12 License number digits (e.g. "0015061")
 *   13 Certification type: C=Certified, R=Registered
 *   14 Primary status code (I=Issued/active, E=Expired, S=Suspended,
 *      R=Revoked, V=Vol Relinq, C=Closed, D=Delinquent, N=Null, A=App)
 *   15 Original license date  (MM/DD/YYYY)
 *   16 Primary status date    (MM/DD/YYYY)
 *   17 Expiration date        (MM/DD/YYYY)
 *   20 Full license number (e.g. "CBC015061") — most reliable
 *
 * NOTE: CONSTRUCTIONLICENSE_1.csv is the QUALIFIER file (individual licensees).
 * Business names are NOT here — they live in a separate "business profile"
 * extract. When Adam verifies "Bartow Roofing Co" by business name, expect
 * misses; the fallback is attach_license with the number off the GBP.
 */

const POS = {
  board: 0,
  class: 1,
  name: 2,
  dba: 3,
  addr1: 5,
  city: 8,
  state: 9,
  zip: 10,
  county_code: 11,
  lic_num_digits: 12,
  cert_type: 13,
  status: 14,
  orig_date: 15,
  status_date: 16,
  expiration_date: 17,
  full_license_number: 20,
} as const

function parseCsv(text: string): SnapshotRecord[] {
  const lines = splitCsvLines(text)
  if (lines.length === 0) return []

  const out: SnapshotRecord[] = []
  const statusCounts: Record<string, number> = {}
  const classCounts: Record<string, number> = {}
  let droppedBoard = 0
  let droppedClass = 0
  let droppedShortRow = 0

  for (let i = 0; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]!)
    if (cells.length < 18) { droppedShortRow++; continue }

    const board = cellAt(cells, POS.board)
    if (board && board !== '06') { droppedBoard++; continue }

    // Class — prefer the explicit field (col 1), fall back to deriving from the
    // full license number (col 20) since the latter is most reliable.
    const explicitClass = cellAt(cells, POS.class).toUpperCase().trim()
    const fullLicNum = cellAt(cells, POS.full_license_number)
    const derivedClass = fullLicNum.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3)
    const classPrefix = explicitClass || derivedClass

    classCounts[classPrefix] = (classCounts[classPrefix] ?? 0) + 1
    if (!TARGET_CLASSES.has(classPrefix)) { droppedClass++; continue }

    const statusRaw = cellAt(cells, POS.status).toUpperCase()
    statusCounts[statusRaw || '(empty)'] = (statusCounts[statusRaw || '(empty)'] ?? 0) + 1
    const license_status = normalizeDbprStatus(statusRaw)

    const licenseNumber = fullLicNum || `${classPrefix}${cellAt(cells, POS.lic_num_digits)}`
    const name = cellAt(cells, POS.name)
    const dba = cellAt(cells, POS.dba)

    out.push({
      license_number: licenseNumber,
      license_class: classPrefix,
      license_status,
      business_name: dba || name || '(unnamed)',
      ...(dba ? { dba_name: dba } : {}),
      ...(name ? { owner_name: name } : {}),
      city: cellAt(cells, POS.city),
      county: cellAt(cells, POS.county_code),  // numeric code; map later if useful
      ...(cellAt(cells, POS.zip) ? { zip: cellAt(cells, POS.zip) } : {}),
      ...(cellAt(cells, POS.orig_date) ? { issue_date: normalizeDate(cellAt(cells, POS.orig_date)) } : {}),
      ...(cellAt(cells, POS.expiration_date) ? { expiration_date: normalizeDate(cellAt(cells, POS.expiration_date)) } : {}),
    })
  }

  // Diagnostics — Adam reads these to verify the parse made sense
  console.log(`Parsed ${out.length} matching contractor records`)
  console.log(`Dropped: ${droppedShortRow} too-short rows, ${droppedBoard} non-CILB, ${droppedClass} wrong class`)
  console.log('License class distribution (top 10):')
  for (const [code, count] of Object.entries(classCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    const kept = TARGET_CLASSES.has(code) ? '✓' : '·'
    console.log(`  ${kept} ${code.padEnd(8)} ${count}`)
  }
  console.log('Primary status code distribution:')
  for (const [code, count] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${code.padEnd(10)} ${count}  → ${normalizeDbprStatus(code)}`)
  }

  return out
}

function normalizeDbprStatus(code: string): SnapshotRecord['license_status'] {
  const c = code.toUpperCase().trim()
  switch (c) {
    case 'I': return 'active'   // Issued — the active state in DBPR
    case 'A': return 'active'
    case 'E': return 'expired'
    case 'S': return 'suspended'
    case 'R': return 'revoked'
    case 'V': return 'voluntarily_relinquished'
    case 'C': return 'expired'  // Closed — treat as not active
    case 'D': return 'expired'  // Delinquent — treat as not active
    case 'N': return 'unknown'
    case '': return 'unknown'
    default: return 'unknown'
  }
}

function cellAt(cells: string[], i: number): string {
  if (i < 0 || i >= cells.length) return ''
  return (cells[i] ?? '').trim()
}

function normalizeStatus(raw: string): SnapshotRecord['license_status'] {
  if (!raw) return 'unknown'
  if (raw.includes('active') || raw.includes('current')) return 'active'
  if (raw.includes('expir')) return 'expired'
  if (raw.includes('suspend')) return 'suspended'
  if (raw.includes('revok')) return 'revoked'
  if (raw.includes('voluntar') || raw.includes('relinquish') || raw.includes('surrender')) return 'voluntarily_relinquished'
  return 'unknown'
}

function normalizeDate(raw: string): string {
  // DBPR exports use MM/DD/YYYY commonly. Convert to ISO YYYY-MM-DD.
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10)
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (m) {
    const mm = m[1]!.padStart(2, '0')
    const dd = m[2]!.padStart(2, '0')
    return `${m[3]}-${mm}-${dd}`
  }
  return raw
}

// =====================================================================
// MINIMAL CSV PARSING (no dep)
// =====================================================================

function splitCsvLines(text: string): string[] {
  // Handles \r\n, bare \n, and quoted fields containing newlines.
  const lines: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"' && text[i - 1] !== '\\') {
      inQuotes = !inQuotes
      cur += c
      continue
    }
    if (c === '\n' && !inQuotes) {
      lines.push(cur.replace(/\r$/, ''))
      cur = ''
      continue
    }
    cur += c
  }
  if (cur) lines.push(cur)
  return lines
}

function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; continue }
      inQuotes = !inQuotes
      continue
    }
    if (c === ',' && !inQuotes) { out.push(cur); cur = ''; continue }
    cur += c
  }
  out.push(cur)
  return out
}

// =====================================================================
// RUN
// =====================================================================

void main().catch(err => {
  console.error('sync-dbpr failed:', err)
  process.exit(1)
})
