/**
 * Server-side auth middleware (Nitro).
 * Pages that require auth declare it via `definePageMeta({ middleware: 'auth' })`.
 * This middleware is the route-level equivalent on the server side.
 *
 * For now, the API routes do their own cookie check (see chat.post.ts, dashboard.get.ts).
 * This file is reserved for future expansion (e.g., per-route ACL, role checks).
 */

export default defineEventHandler((event) => {
  // No-op for now. Cookie check happens per-route in the API handlers.
  // Keeping this file scaffolded so the `middleware/auth` page meta resolves later.
  void event
})
