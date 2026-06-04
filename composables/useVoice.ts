// Voice in (Web Speech API) + voice out (ElevenLabs primary, browser SpeechSynthesis fallback).
// Server route /api/speak returns an MP3 from ElevenLabs; if it 503s (no API key) we fall back here.

export function useVoice() {
  const listening = ref(false)
  const speaking = ref(false)
  const transcript = ref('')

  const SpeechRecognition = typeof window !== 'undefined'
    ? (window.SpeechRecognition ?? window.webkitSpeechRecognition)
    : null

  const isVoiceAvailable = computed(() => !!SpeechRecognition)

  let recognition: SpeechRecognition | null = null
  let currentAudio: HTMLAudioElement | null = null

  function ensureRecognition(): SpeechRecognition | null {
    if (!SpeechRecognition) return null
    if (recognition) return recognition
    const r: SpeechRecognition = new SpeechRecognition()
    r.lang = 'en-US'
    r.interimResults = false
    r.continuous = false
    r.maxAlternatives = 1
    r.onresult = (event) => {
      const last = event.results[event.results.length - 1]
      if (last) {
        const alt = last[0]
        if (alt) transcript.value = alt.transcript
      }
    }
    r.onend = () => { listening.value = false }
    r.onerror = () => { listening.value = false }
    recognition = r
    return r
  }

  function startListening(): void {
    const r = ensureRecognition()
    if (!r) return
    transcript.value = ''
    try {
      r.start()
      listening.value = true
    } catch {
      // already running; ignore
    }
  }

  function stopListening(): void {
    recognition?.stop()
    listening.value = false
  }

  async function speak(text: string): Promise<void> {
    if (!text.trim()) return
    speaking.value = true
    try {
      const res = await fetch('/api/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
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
        // Fallback: browser SpeechSynthesis
        speakBrowser(text)
      }
    } catch {
      speakBrowser(text)
    }
  }

  function speakBrowser(text: string): void {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      speaking.value = false
      return
    }
    const u = new SpeechSynthesisUtterance(text)
    u.rate = 1.0
    u.pitch = 0.95
    // Prefer a deeper / British / calm voice if available
    const voices = window.speechSynthesis.getVoices()
    const preferred = voices.find(v => /daniel|google uk english male|microsoft george|alex/i.test(v.name))
    if (preferred) u.voice = preferred
    u.onend = () => { speaking.value = false }
    window.speechSynthesis.speak(u)
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
    speaking,
    transcript,
    isVoiceAvailable,
    startListening,
    stopListening,
    speak,
    stopSpeaking,
  }
}
