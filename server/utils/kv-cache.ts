/**
 * Tiny deterministic-call cache backed by KV.
 *
 * Usage:
 *   const result = await memoize('search:' + hash(query), 6 * 3600, () => doExpensiveCall())
 *
 * If the value exists and isn't expired (TTL handled by KV), it's returned
 * without calling fn. Otherwise fn runs, the result is stored, and returned.
 */
import { kv } from './kv'

export async function memoize<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<{ value: T; cached: boolean }> {
  const cached = await kv().get<T>(key)
  if (cached !== null) return { value: cached, cached: true }
  const value = await fn()
  await kv().set(key, value, ttlSeconds)
  return { value, cached: false }
}

/** Stable hash for cache keys — non-crypto, just for collision-resistant keying */
export function hashKey(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}
