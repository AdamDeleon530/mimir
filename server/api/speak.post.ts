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
    setResponseStatus(event, 503)
    return { error: 'ElevenLabs not configured — using browser fallback', fallback: true }
  }

  const voiceId = config.elevenlabsVoiceId || 'nPczCjzI2devNBz1zQrb'
  // Default to multilingual_v2 — broadest voice compatibility, including most custom/cloned voices.
  // Override via NUXT_ELEVENLABS_MODEL_ID if you want turbo (lower latency, fewer voices supported).
  const modelId = config.elevenlabsModelId || 'eleven_multilingual_v2'

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`

  // Server-side log so you can verify the right voice is being used
  console.log(`[speak] voice=${voiceId} model=${modelId} text_len=${body.text.length}`)

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'audio/mpeg',
      'Content-Type': 'application/json',
      'xi-api-key': config.elevenlabsApiKey,
    },
    body: JSON.stringify({
      text: body.text.slice(0, 1500),
      model_id: modelId,
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.75,
        style: 0.15,
        use_speaker_boost: true,
      },
    }),
  })

  if (!res.ok) {
    const errText = await res.text()
    console.error(`[speak] ElevenLabs ${res.status} for voice=${voiceId} model=${modelId}:`, errText.slice(0, 500))
    setResponseStatus(event, 503)
    return {
      error: 'ElevenLabs upstream error — using browser fallback',
      fallback: true,
      // Surface the actual ElevenLabs error so debugging is fast
      diagnostic: { status: res.status, voiceId, modelId, body: errText.slice(0, 500) },
    }
  }

  const audio = await res.arrayBuffer()
  setResponseHeader(event, 'Content-Type', 'audio/mpeg')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return new Uint8Array(audio)
})
