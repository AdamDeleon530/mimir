/**
 * GET /api/voice-debug — verify which voice is configured and that your API key works.
 * Returns the configured voice ID + a list of voices your ElevenLabs account has access to.
 * Use this to check that NUXT_ELEVENLABS_VOICE_ID is being read correctly + your custom voice is on the list.
 */
export default defineEventHandler(async (event) => {
  const session = getCookie(event, 'mimir-session')
  if (!session) throw createError({ statusCode: 401, message: 'unauthorized' })

  const config = useRuntimeConfig()
  const configured = {
    voiceId: config.elevenlabsVoiceId,
    modelId: config.elevenlabsModelId,
    keyPresent: !!config.elevenlabsApiKey,
    keyPrefix: config.elevenlabsApiKey ? config.elevenlabsApiKey.slice(0, 8) + '...' : null,
  }

  if (!config.elevenlabsApiKey) {
    return { configured, voices: [], note: 'No API key set.' }
  }

  // Fetch the list of voices visible to this API key
  const res = await fetch('https://api.elevenlabs.io/v2/voices', {
    headers: { 'xi-api-key': config.elevenlabsApiKey },
  })
  if (!res.ok) {
    return {
      configured,
      voices: [],
      error: `ElevenLabs returned ${res.status}`,
      body: (await res.text()).slice(0, 300),
    }
  }
  const data = await res.json() as { voices?: Array<{ voice_id: string; name: string; category?: string }> }
  const voices = (data.voices ?? []).map(v => ({
    voice_id: v.voice_id,
    name: v.name,
    category: v.category,
    matches_configured: v.voice_id === config.elevenlabsVoiceId,
  }))
  const match = voices.find(v => v.matches_configured)
  return {
    configured,
    voices,
    matchedVoice: match ?? null,
    note: match
      ? `Configured voice "${match.name}" is visible to this key.`
      : 'WARNING: configured voiceId is NOT in the voices visible to this key. Either the voiceId is wrong, the voice was created on a different account, or your plan does not include it.',
  }
})
