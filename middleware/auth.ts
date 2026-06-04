/**
 * Client-side route middleware — guards /dashboard and /chat.
 * Checks for the session cookie via a lightweight ping to /api/me.
 * Redirects to / if not authenticated.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server) return // server-side rendering — let it through; API will gate
  try {
    await $fetch('/api/me')
  } catch {
    return navigateTo('/')
  }
})
