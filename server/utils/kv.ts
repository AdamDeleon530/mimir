/**
 * Unified KV interface.
 *
 * In production: Upstash REST API (works with Vercel KV — same underlying
 * service, same REST endpoints). Pure fetch — no driver, no dep.
 *
 * In dev (no Upstash creds): files under .kv-cache/ as a flat JSON map. Good
 * enough for local iteration, terrible for production. Pick one.
 *
 * Env var detection:
 *   - KV_REST_API_URL + KV_REST_API_TOKEN   (Vercel KV style)
 *   - UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN  (raw Upstash style)
 * Either pair works. If neither is set, falls back to the file backend.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// =====================================================================
// PUBLIC INTERFACE
// =====================================================================

export interface KvStore {
  get<T = unknown>(key: string): Promise<T | null>
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>
  del(key: string): Promise<void>
  incr(key: string, by?: number): Promise<number>
  /** Right-push to a list (used for append-only logs like briefings) */
  rpush(key: string, value: unknown): Promise<void>
  /** Range read of a list. Negative indices supported (Redis-style). */
  lrange<T = unknown>(key: string, start: number, stop: number): Promise<T[]>
  /** Trim a list to a sub-range — use to cap log size */
  ltrim(key: string, start: number, stop: number): Promise<void>
  /** Existence check */
  exists(key: string): Promise<boolean>
  /** Reports which backend is wired (for debug endpoints). */
  backend(): 'upstash' | 'file'
}

// =====================================================================
// UPSTASH (REST) BACKEND
// =====================================================================

interface UpstashCreds {
  url: string
  token: string
}

function upstashCreds(): UpstashCreds | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? ''
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? ''
  if (!url || !token) return null
  return { url, token }
}

async function upstashCall(creds: UpstashCreds, command: (string | number)[]): Promise<{ result: unknown }> {
  const res = await fetch(creds.url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${creds.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Upstash ${res.status} on ${command[0]}: ${text.slice(0, 200)}`)
  }
  return await res.json() as { result: unknown }
}

function makeUpstashStore(creds: UpstashCreds): KvStore {
  return {
    backend: () => 'upstash',
    async get<T>(key: string): Promise<T | null> {
      const { result } = await upstashCall(creds, ['GET', key])
      if (result == null) return null
      if (typeof result !== 'string') return result as T
      try { return JSON.parse(result) as T } catch { return result as unknown as T }
    },
    async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
      const payload = typeof value === 'string' ? value : JSON.stringify(value)
      const cmd: (string | number)[] = ['SET', key, payload]
      if (ttlSeconds && ttlSeconds > 0) cmd.push('EX', ttlSeconds)
      await upstashCall(creds, cmd)
    },
    async del(key: string): Promise<void> {
      await upstashCall(creds, ['DEL', key])
    },
    async incr(key: string, by = 1): Promise<number> {
      const { result } = await upstashCall(creds, by === 1 ? ['INCR', key] : ['INCRBY', key, by])
      return Number(result ?? 0)
    },
    async rpush(key: string, value: unknown): Promise<void> {
      const payload = typeof value === 'string' ? value : JSON.stringify(value)
      await upstashCall(creds, ['RPUSH', key, payload])
    },
    async lrange<T>(key: string, start: number, stop: number): Promise<T[]> {
      const { result } = await upstashCall(creds, ['LRANGE', key, start, stop])
      if (!Array.isArray(result)) return []
      return result.map((r) => {
        if (typeof r !== 'string') return r as T
        try { return JSON.parse(r) as T } catch { return r as unknown as T }
      })
    },
    async ltrim(key: string, start: number, stop: number): Promise<void> {
      await upstashCall(creds, ['LTRIM', key, start, stop])
    },
    async exists(key: string): Promise<boolean> {
      const { result } = await upstashCall(creds, ['EXISTS', key])
      return Number(result ?? 0) > 0
    },
  }
}

// =====================================================================
// FILE BACKEND — local dev fallback
// =====================================================================

interface FileState {
  // key → either a serialized value (string/JSON) or an array (for lists)
  [key: string]: unknown
}

const FILE_PATH = join(process.cwd(), 'server', 'data', 'kv-cache.json')

function readFileState(): FileState {
  if (!existsSync(FILE_PATH)) {
    mkdirSync(join(process.cwd(), 'server', 'data'), { recursive: true })
    writeFileSync(FILE_PATH, '{}')
    return {}
  }
  try {
    return JSON.parse(readFileSync(FILE_PATH, 'utf-8')) as FileState
  } catch {
    return {}
  }
}

function writeFileState(state: FileState): void {
  writeFileSync(FILE_PATH, JSON.stringify(state, null, 2))
}

function makeFileStore(): KvStore {
  return {
    backend: () => 'file',
    async get<T>(key: string): Promise<T | null> {
      const state = readFileState()
      const v = state[key]
      return (v ?? null) as T | null
    },
    async set(key: string, value: unknown): Promise<void> {
      // TTL ignored in file backend — for dev only
      const state = readFileState()
      state[key] = value
      writeFileState(state)
    },
    async del(key: string): Promise<void> {
      const state = readFileState()
      delete state[key]
      writeFileState(state)
    },
    async incr(key: string, by = 1): Promise<number> {
      const state = readFileState()
      const current = Number(state[key] ?? 0)
      const next = current + by
      state[key] = next
      writeFileState(state)
      return next
    },
    async rpush(key: string, value: unknown): Promise<void> {
      const state = readFileState()
      const list = Array.isArray(state[key]) ? state[key] as unknown[] : []
      list.push(value)
      state[key] = list
      writeFileState(state)
    },
    async lrange<T>(key: string, start: number, stop: number): Promise<T[]> {
      const state = readFileState()
      const list = Array.isArray(state[key]) ? state[key] as T[] : []
      // Redis LRANGE semantics: inclusive on both ends, supports negatives
      const len = list.length
      const s = start < 0 ? Math.max(0, len + start) : start
      const e = stop < 0 ? Math.max(0, len + stop) : Math.min(len - 1, stop)
      if (s > e) return []
      return list.slice(s, e + 1)
    },
    async ltrim(key: string, start: number, stop: number): Promise<void> {
      const state = readFileState()
      const list = Array.isArray(state[key]) ? state[key] as unknown[] : []
      const len = list.length
      const s = start < 0 ? Math.max(0, len + start) : start
      const e = stop < 0 ? Math.max(0, len + stop) : Math.min(len - 1, stop)
      state[key] = s > e ? [] : list.slice(s, e + 1)
      writeFileState(state)
    },
    async exists(key: string): Promise<boolean> {
      const state = readFileState()
      return state[key] !== undefined
    },
  }
}

// =====================================================================
// SINGLETON
// =====================================================================

let _store: KvStore | null = null

export function kv(): KvStore {
  if (_store) return _store
  const creds = upstashCreds()
  _store = creds ? makeUpstashStore(creds) : makeFileStore()
  return _store
}

export function kvBackend(): 'upstash' | 'file' {
  return kv().backend()
}
