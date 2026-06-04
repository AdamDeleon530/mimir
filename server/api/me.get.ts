/**
 * GET /api/me — lightweight session check.
 * Used by the client-side auth middleware to verify the cookie is still valid.
 */
export default defineEventHandler((event) => {
  const session = getCookie(event, 'mimir-session')
  if (!session) throw createError({ statusCode: 401, message: 'unauthorized' })
  return { ok: true }
})
