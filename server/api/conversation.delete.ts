/**
 * DELETE /api/conversation
 * Clears the persisted conversation history for the current session.
 */
import { clearConversation, sessionIdFromCookie } from '~/server/utils/conversation-memory'

export default defineEventHandler(async (event) => {
  const session = getCookie(event, 'mimir-session')
  if (!session) throw createError({ statusCode: 401, message: 'unauthorized' })
  await clearConversation(sessionIdFromCookie(session))
  return { ok: true }
})
