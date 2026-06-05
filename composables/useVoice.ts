// Voice in: MediaRecorder → ElevenLabs Scribe (via /api/transcribe)
// Voice out: ElevenLabs TTS (via /api/speak) with browser SpeechSynthesis fallback
//
// We use MediaRecorder + a server STT roundtrip because Chrome's free Web Speech API
// is unreliable (network errors on localhost, region-blocked, rate-limited). Scribe
// uses the same ElevenLabs key as TTS, so no new account.

// =====================================================================
// Strip markdown before TTS so asterisks, backticks, hashes, list
// markers, link syntax, and tables don't get read aloud. Visual UI
// keeps the markdown — only the spoken version is sanitized.
// =====================================================================
export function stripMarkdownForSpeech(input: string): string {
  let s = input

  // Fenced code blocks — drop entirely (don't speak code)
  s = s.replace(/```[\s\S]*?```/g, ' ')
  // Inline code — keep the contents, drop the backticks
  s = s.replace(/`([^`]+)`/g, '$1')

  // Images ![alt](url) — keep alt only
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  // Links [text](url) — keep text only
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')

  // Bold/italic (** __ * _) — keep contents
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
  s = s.replace(/___([^_]+)___/g, '$1')
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/__([^_]+)__/g, '$1')
  s = s.replace(/(^|\s)\*([^*\n]+)\*/g, '$1$2')
  s = s.replace(/(^|\s)_([^_\n]+)_/g, '$1$2')
  // Strikethrough
  s = s.replace(/~~([^~]+)~~/g, '$1')

  // Headers — drop the # markers, keep text
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '')

  // Blockquote markers
  s = s.replace(/^\s{0,3}>\s?/gm, '')

  // Bullet markers (-, *, +) at line start
  s = s.replace(/^\s*[-*+]\s+/gm, '')
  // Numbered list markers
  s = s.replace(/^\s*\d+\.\s+/gm, '')

  // Tables — strip leading/trailing pipes, separator rows, and inner pipes
  s = s.replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/gm, '') // separator row
  s = s.replace(/\|/g, ' ') // remaining pipes become spaces

  // Horizontal rules
  s = s.replace(/^\s*[-*_]{3,}\s*$/gm, '. ')

  // HTML tags (just in case)
  s = s.replace(/<[^>]+>/g, ' ')

  // Collapse whitespace
  s = s.replace(/\n{2,}/g, '. ').replace(/\n/g, ' ').replace(/\s{2,}/g, ' ').trim()

  return s
}

export function useVoice() {
  const listening = ref(false)        // user is currently recording
  const transcribing = ref(false)     // we have audio, waiting for Scribe
  const speaking = ref(false)
  const transcript = ref('')          // final transcript after Scribe returns
  const voiceError = ref('')

  let mediaRecorder: MediaRecorder | null = null
  let mediaStream: MediaStream | null = null
  let recordedChunks: Blob[] = []
  let currentAudio: HTMLAudioElement | null = null

  const isVoiceAvailable = computed(() => {
    if (typeof window === 'undefined') return false
    return !!(navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined')
  })

  async function startListening(): Promise<void> {
    if (!isVoiceAvailable.value) {
      voiceError.value = 'voice input not supported in this browser. try Chrome, Safari, or Edge.'
      return
    }
    voiceError.value = ''
    transcript.value = ''
    recordedChunks = []

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      const name = err instanceof Error ? err.name : ''
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        voiceError.value = 'mic permission denied. enable in browser settings (lock icon → Site settings → Microphone → Allow), then reload.'
      } else if (name === 'NotFoundError') {
        voiceError.value = 'no microphone found on this device.'
      } else {
        voiceError.value = `mic access failed: ${name || 'unknown'}`
      }
      return
    }

    // Choose the best codec the browser supports for Scribe
    const mimeType = pickMimeType()
    try {
      mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined)
    } catch (err) {
      voiceError.value = 'browser cannot record audio with a supported codec.'
      stopStream()
      return
    }

    mediaRecorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data)
    }

    mediaRecorder.onstop = async () => {
      stopStream()
      listening.value = false
      if (!recordedChunks.length) return
      await transcribeAndExpose()
    }

    mediaRecorder.start()
    listening.value = true
  }

  function stopListening(): void {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop()  // onstop handler completes the rest
    }
  }

  async function transcribeAndExpose(): Promise<void> {
    transcribing.value = true
    try {
      const mime = recordedChunks[0]?.type || 'audio/webm'
      const blob = new Blob(recordedChunks, { type: mime })
      const form = new FormData()
      form.append('audio', blob, `recording.${extFor(mime)}`)
      const res = await $fetch<{ text: string }>('/api/transcribe', {
        method: 'POST',
        body: form,
      })
      transcript.value = res.text ?? ''
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error'
      voiceError.value = `transcription failed: ${msg}`
    } finally {
      transcribing.value = false
    }
  }

  function stopStream(): void {
    mediaStream?.getTracks().forEach(t => t.stop())
    mediaStream = null
  }

  function pickMimeType(): string | undefined {
    if (typeof MediaRecorder === 'undefined') return undefined
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4;codecs=mp4a.40.2',  // Safari
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ]
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c)) return c
    }
    return undefined
  }

  function extFor(mime: string): string {
    if (mime.includes('webm')) return 'webm'
    if (mime.includes('mp4')) return 'm4a'
    if (mime.includes('ogg')) return 'ogg'
    return 'webm'
  }

  // ----- Voice out (TTS) — unchanged -----

  // Voice mode preference, persisted in localStorage. Default = 'browser' (fast + free).
  // Flip to 'elevenlabs' if you want richer voice quality at the cost of latency + credits.
  const voiceModePref = ref<'browser' | 'elevenlabs'>('browser')
  if (typeof window !== 'undefined') {
    const saved = window.localStorage?.getItem('mimir-voice-mode')
    if (saved === 'browser' || saved === 'elevenlabs') voiceModePref.value = saved
  }

  function setVoiceMode(mode: 'browser' | 'elevenlabs'): void {
    voiceModePref.value = mode
    if (typeof window !== 'undefined') window.localStorage?.setItem('mimir-voice-mode', mode)
  }

  async function speak(text: string): Promise<void> {
    // Strip markdown FIRST — what the UI shows is the rich version,
    // what TTS speaks is the clean version. Single source of truth.
    const cleanText = stripMarkdownForSpeech(text)
    if (!cleanText.trim()) return
    speaking.value = true

    // Browser mode: skip ElevenLabs entirely. Instant, free, local.
    if (voiceModePref.value === 'browser') {
      speakBrowser(cleanText)
      return
    }

    // ElevenLabs path with browser fallback on failure
    try {
      const res = await fetch('/api/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: cleanText }),
      })
      if (res.ok && res.headers.get('content-type')?.startsWith('audio/')) {
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        currentAudio?.pause()
        const audio = new Audio(url)
        currentAudio = audio
        audio.onended = () => {
          speaking.value = false
          URL.revokeObjectURL(url)
        }
        await audio.play()
      } else {
        speakBrowser(cleanText)
      }
    } catch {
      speakBrowser(cleanText)
    }
  }

  function speakBrowser(text: string): void {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      speaking.value = false
      return
    }
    const u = new SpeechSynthesisUtterance(text)
    u.rate = 1.05
    u.pitch = 0.95

    // Voice picker — prefer high-quality macOS / Edge neural voices in priority order.
    // These run locally with ~0ms latency.
    const voices = window.speechSynthesis.getVoices()
    const preferenceOrder = [
      // macOS premium voices (best quality, usually need to be downloaded once via System Preferences → Accessibility → Spoken Content)
      /^Daniel \(Premium\)/i,    // British male, very rich
      /^Daniel \(Enhanced\)/i,
      /^Alex$/i,                  // Apple's old flagship US male voice
      /^Samantha \(Premium\)/i,   // US female, very rich
      /^Samantha \(Enhanced\)/i,
      // Standard macOS / iOS voices
      /^Daniel$/i,                // British male
      /^Karen$/i,                 // Australian female
      /^Moira$/i,                 // Irish female
      /^Samantha$/i,              // US female
      // Microsoft Edge neural voices (Windows / Edge browser)
      /Microsoft Guy Online \(Natural\)/i,
      /Microsoft Davis Online \(Natural\)/i,
      /Microsoft Aria Online \(Natural\)/i,
      // Google Chrome voices
      /Google UK English Male/i,
      /Google US English/i,
    ]
    let chosen: SpeechSynthesisVoice | undefined
    for (const pattern of preferenceOrder) {
      chosen = voices.find(v => pattern.test(v.name))
      if (chosen) break
    }
    if (chosen) u.voice = chosen

    u.onend = () => { speaking.value = false }
    u.onerror = () => { speaking.value = false }
    window.speechSynthesis.speak(u)
  }

  function listAvailableVoices(): SpeechSynthesisVoice[] {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return []
    return window.speechSynthesis.getVoices().filter(v => v.lang.startsWith('en'))
  }

  function stopSpeaking(): void {
    currentAudio?.pause()
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel()
    }
    speaking.value = false
  }

  return {
    listening,
    transcribing,
    speaking,
    transcript,
    voiceError,
    isVoiceAvailable,
    startListening,
    stopListening,
    speak,
    stopSpeaking,
    // Voice mode picker
    voiceModePref,
    setVoiceMode,
    listAvailableVoices,
  }
}
