import { randomBytes, timingSafeEqual } from 'node:crypto'

interface AuthRequest {
  password: string
}

export default defineEventHandler(async (event) => {
  const body = await readBody<AuthRequest>(event)
  if (!body?.password) {
    throw createError({ statusCode: 400, message: 'password required' })
  }

  const config = useRuntimeConfig()
  const expected = config.appPassword
  if (!expected) {
    throw createError({ statusCode: 500, message: 'NUXT_APP_PASSWORD not configured' })
  }

  // Constant-time comparison to prevent timing attacks
  const given = Buffer.from(body.password)
  const want = Buffer.from(expected)
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    // Add a small delay to slow brute-forcing
    await new Promise(r => setTimeout(r, 250))
    throw createError({ statusCode: 401, message: 'wrong password' })
  }

  // Set a session cookie. Random token = simple signed session.
  const token = randomBytes(32).toString('base64url')
  setCookie(event, 'mimir-session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: '/',
  })

  return { ok: true }
})
