/**
 * GET /api/conversation
 * Returns the persisted conversation history for the current session.
 */
import { loadConversation, sessionIdFromCookie } from '~/server/utils/conversation-memory'

export default defineEventHandler(async (event) => {
  const session = getCookie(event, 'mimir-session')
  if (!session) throw createError({ statusCode: 401, message: 'unauthorized' })
  const messages = await loadConversation(sessionIdFromCookie(session))
  return { messages }
})
