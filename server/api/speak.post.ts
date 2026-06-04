interface SpeakRequest {
  text: string
}

/**
 * POST /api/speak
 * Calls ElevenLabs TTS and returns an MP3 stream.
 * Returns 503 if NUXT_ELEVENLABS_API_KEY is missing — client falls back to browser SpeechSynthesis.
 */
export default defineEventHandler(async (event) => {
  const session = getCookie(event, 'mimir-session')
  if (!session) throw createError({ statusCode: 401, message: 'unauthorized' })

  const body = await readBody<SpeakRequest>(event)
  if (!body?.text?.trim()) {
    throw createError({ statusCode: 400, message: 'text required' })
  }

  const config = useRuntimeConfig()
  if (!config.elevenlabsApiKey) {
    // Tell the client to fall back to browser TTS
    setResponseStatus(event, 503)
    return { error: 'ElevenLabs not configured — using browser fallback', fallback: true }
  }

  const voiceId = config.elevenlabsVoiceId || 'nPczCjzI2devNBz1zQrb'
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'audio/mpeg',
      'Content-Type': 'application/json',
      'xi-api-key': config.elevenlabsApiKey,
    },
    body: JSON.stringify({
      text: body.text.slice(0, 1500), // ElevenLabs char limit + free-tier protection
      model_id: 'eleven_turbo_v2_5',  // fastest, lowest latency
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.75,
        style: 0.15, // slight character without going theatrical
        use_speaker_boost: true,
      },
    }),
  })

  if (!res.ok) {
    const errText = await res.text()
    console.error('[speak] ElevenLabs error', res.status, errText)
    setResponseStatus(event, 503)
    return { error: 'ElevenLabs upstream error — using browser fallback', fallback: true }
  }

  const audio = await res.arrayBuffer()
  setResponseHeader(event, 'Content-Type', 'audio/mpeg')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return new Uint8Array(audio)
})
