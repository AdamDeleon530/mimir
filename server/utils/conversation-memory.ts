/**
 * Persistent conversation memory for Mimir.
 *
 * Each browser session gets a key. We persist the last MAX_TURNS_KEPT
 * messages so reopening the dashboard restores the conversation.
 *
 * Session ID: derived from the auth cookie (same value already in use as
 * the password gate). One Adam = one conversation history.
 */
import { kv } from './kv'

const KEY = (sessionId: string) => `mimir:conversation:${sessionId}`
const MAX_TURNS_KEPT = 50

export interface StoredMessage {
  role: 'user' | 'assistant'
  content: string
  at: string
}

export async function loadConversation(sessionId: string): Promise<StoredMessage[]> {
  const stored = await kv().get<StoredMessage[]>(KEY(sessionId))
  return Array.isArray(stored) ? stored : []
}

export async function saveConversation(sessionId: string, messages: StoredMessage[]): Promise<void> {
  const trimmed = messages.slice(-MAX_TURNS_KEPT)
  await kv().set(KEY(sessionId), trimmed)
}

export async function appendTurns(sessionId: string, newTurns: StoredMessage[]): Promise<void> {
  if (newTurns.length === 0) return
  const existing = await loadConversation(sessionId)
  const merged = [...existing, ...newTurns].slice(-MAX_TURNS_KEPT)
  await kv().set(KEY(sessionId), merged)
}

export async function clearConversation(sessionId: string): Promise<void> {
  await kv().del(KEY(sessionId))
}

/** Stable session key — keeps history consistent within a single signed-in browser. */
export function sessionIdFromCookie(cookie: string): string {
  // Light hash so we don't store the literal password as a key
  let h = 7
  for (let i = 0; i < cookie.length; i++) h = (h * 33 + cookie.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
