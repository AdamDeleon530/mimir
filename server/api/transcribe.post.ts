/**
 * POST /api/transcribe — multipart/form-data audio blob → ElevenLabs Scribe → transcript text
 *
 * Why this exists: Chrome's Web Speech API STT is unreliable (network errors on localhost,
 * region-blocked, gets rate-limited). ElevenLabs Scribe is the same vendor as our TTS, so
 * no new account needed, and it works anywhere we can make an HTTPS request from.
 */
export default defineEventHandler(async (event) => {
  const session = getCookie(event, 'mimir-session')
  if (!session) throw createError({ statusCode: 401, message: 'unauthorized' })

  const config = useRuntimeConfig()
  if (!config.elevenlabsApiKey) {
    throw createError({ statusCode: 503, message: 'ElevenLabs API key not configured — voice input requires NUXT_ELEVENLABS_API_KEY' })
  }

  // readMultipartFormData returns the parsed form fields/files
  const formData = await readMultipartFormData(event)
  if (!formData?.length) {
    throw createError({ statusCode: 400, message: 'audio file required' })
  }

  const audioField = formData.find(f => f.name === 'audio')
  if (!audioField?.data) {
    throw createError({ statusCode: 400, message: 'audio field missing' })
  }

  // Forward to ElevenLabs Scribe
  const upstreamForm = new FormData()
  const audioBlob = new Blob([audioField.data], { type: audioField.type || 'audio/webm' })
  upstreamForm.append('file', audioBlob, audioField.filename || 'recording.webm')
  upstreamForm.append('model_id', 'scribe_v1')
  upstreamForm.append('language_code', 'eng')

  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: {
      'xi-api-key': config.elevenlabsApiKey,
      // Do NOT set Content-Type — let fetch set the multipart boundary
    },
    body: upstreamForm,
  })

  if (!res.ok) {
    const errText = await res.text()
    console.error('[transcribe] ElevenLabs error', res.status, errText)
    throw createError({
      statusCode: 502,
      message: `transcription failed: ${res.status}`,
    })
  }

  const result = await res.json() as { text?: string; language_code?: string }
  return {
    text: (result.text ?? '').trim(),
    language: result.language_code,
  }
})
