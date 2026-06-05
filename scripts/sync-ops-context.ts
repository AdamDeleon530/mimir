/**
 * Reads every .md and .json from ~/Personal/NordicNerd-Ops/ and writes a
 * searchable snapshot to server/data/ops-context.json.
 *
 * Run with `pnpm sync-ops` whenever the ops library changes.
 * The output is committed and bundled into the Mimir deployment so the
 * `search_ops_library` tool works in production without filesystem access.
 */
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { homedir } from 'node:os'

const OPS_DIR = process.env.OPS_DIR ?? join(homedir(), 'Personal', 'NordicNerd-Ops')
const OUTPUT = join(process.cwd(), 'server', 'data', 'ops-context.json')

interface OpsFile {
  path: string
  title: string
  folder: string
  content: string
  excerpt: string
  tags: string[]
  bytes: number
}

if (!existsSync(OPS_DIR)) {
  console.error(`[sync-ops] Ops library not found at ${OPS_DIR}`)
  console.error(`[sync-ops] Set OPS_DIR env var, or run from a machine with the ops library mounted.`)
  // Write an empty snapshot so the build still succeeds
  mkdirSync(dirname(OUTPUT), { recursive: true })
  writeFileSync(OUTPUT, JSON.stringify({
    files: [],
    syncedAt: new Date().toISOString(),
    sourceDir: OPS_DIR,
    note: 'Ops library not found at sync time. Run pnpm sync-ops locally to populate.',
  }, null, 2))
  process.exit(0)
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...walk(full))
    } else if (entry.endsWith('.md') || entry.endsWith('.json')) {
      out.push(full)
    }
  }
  return out
}

function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)$/m)
  return match?.[1]?.trim() ?? fallback
}

function makeExcerpt(content: string): string {
  // First non-header paragraph, max 200 chars
  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('#')) continue
    if (trimmed.startsWith('>')) continue
    if (trimmed.startsWith('```')) continue
    if (trimmed.startsWith('|')) continue
    if (trimmed.startsWith('-') || trimmed.startsWith('*')) continue
    return trimmed.slice(0, 200) + (trimmed.length > 200 ? '...' : '')
  }
  return ''
}

const files: OpsFile[] = []
for (const filepath of walk(OPS_DIR)) {
  try {
    const content = readFileSync(filepath, 'utf-8')
    const rel = relative(OPS_DIR, filepath)
    const segments = rel.split('/')
    const folder = segments.length > 1 ? segments[0]! : '(root)'
    const filename = segments[segments.length - 1]!
    files.push({
      path: rel,
      title: extractTitle(content, filename),
      folder,
      content,
      excerpt: makeExcerpt(content),
      tags: segments.slice(0, -1),
      bytes: content.length,
    })
  } catch (err) {
    console.warn(`[sync-ops] Skipped ${filepath}:`, err instanceof Error ? err.message : err)
  }
}

mkdirSync(dirname(OUTPUT), { recursive: true })
writeFileSync(OUTPUT, JSON.stringify({
  files,
  syncedAt: new Date().toISOString(),
  sourceDir: OPS_DIR,
  fileCount: files.length,
  totalBytes: files.reduce((s, f) => s + f.bytes, 0),
}, null, 2))

console.log(`[sync-ops] ${files.length} files synced, ${(files.reduce((s, f) => s + f.bytes, 0) / 1024).toFixed(1)} KB total → ${OUTPUT}`)
