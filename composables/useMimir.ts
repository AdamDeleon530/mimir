interface Message {
  role: 'user' | 'assistant'
  content: string
  // Optional tool trace surfaced inline so the UI can show "calling search_leads…"
  toolUse?: ToolUseEvent[]
}

interface ToolUseEvent {
  name: string
  input?: unknown
  preview?: string  // truncated result for the UI
  state: 'running' | 'done'
}

export function useMimir() {
  const messages = useState<Message[]>('mimir-messages', () => [])
  const sending = ref(false)
  const lastReply = ref('')
  // Live tool-call indicator — what is Mimir currently calling?
  const activeTools = ref<ToolUseEvent[]>([])
  const memoryLoaded = ref(false)

  /** Load persisted conversation from KV on first mount. Idempotent. */
  async function loadMemory(): Promise<void> {
    if (memoryLoaded.value) return
    try {
      const res = await $fetch<{ messages: Array<{ role: 'user' | 'assistant'; content: string }> }>('/api/conversation')
      if (res.messages?.length) {
        messages.value = res.messages.map(m => ({ role: m.role, content: m.content }))
      }
    } catch { /* fail open — no history is fine */ }
    memoryLoaded.value = true
  }

  async function send(content: string): Promise<void> {
    messages.value.push({ role: 'user', content })
    sending.value = true
    activeTools.value = []

    // Append a placeholder assistant message that we'll fill in as tokens arrive.
    const assistantIndex = messages.value.length
    messages.value.push({ role: 'assistant', content: '', toolUse: [] })

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: messages.value
            .slice(0, assistantIndex)
            .map(m => ({ role: m.role, content: m.content })),
        }),
      })
      if (!res.ok || !res.body) {
        throw new Error(`chat failed: ${res.status}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // SSE messages separated by blank line
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() ?? ''  // keep trailing partial

        for (const block of blocks) {
          const parsed = parseSseBlock(block)
          if (!parsed) continue
          handleEvent(parsed.event, parsed.data, assistantIndex)
        }
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : 'something went wrong'
      const target = messages.value[assistantIndex]
      if (target) target.content = `the well is murky — ${errMsg}`
    } finally {
      sending.value = false
      activeTools.value = []
    }
  }

  function handleEvent(eventName: string, data: Record<string, unknown>, assistantIndex: number): void {
    const target = messages.value[assistantIndex]
    if (!target) return

    switch (eventName) {
      case 'text': {
        const delta = typeof data.delta === 'string' ? data.delta : ''
        target.content += delta
        break
      }
      case 'tool_start': {
        const ev: ToolUseEvent = {
          name: typeof data.name === 'string' ? data.name : 'unknown',
          input: data.input,
          state: 'running',
        }
        if (!target.toolUse) target.toolUse = []
        target.toolUse.push(ev)
        activeTools.value = [...activeTools.value, ev]
        break
      }
      case 'tool_end': {
        const name = typeof data.name === 'string' ? data.name : ''
        const preview = typeof data.preview === 'string' ? data.preview : ''
        const last = target.toolUse?.find(t => t.name === name && t.state === 'running')
        if (last) {
          last.state = 'done'
          last.preview = preview
        }
        activeTools.value = activeTools.value.filter(t => t.name !== name || t.state !== 'running')
        break
      }
      case 'done': {
        const reply = typeof data.reply === 'string' ? data.reply : target.content
        // Final reply replaces accumulated text — covers the case where
        // the model emitted text in earlier turns we don't want to keep.
        target.content = reply
        lastReply.value = reply
        break
      }
      case 'error': {
        const msg = typeof data.message === 'string' ? data.message : 'unknown error'
        target.content = `the well is murky — ${msg}`
        break
      }
    }
  }

  async function clear(): Promise<void> {
    messages.value = []
    lastReply.value = ''
    activeTools.value = []
    try { await $fetch('/api/conversation', { method: 'DELETE' }) }
    catch { /* best-effort */ }
  }

  return { messages, sending, lastReply, activeTools, send, clear, loadMemory, memoryLoaded }
}

// =====================================================================
// SSE block parser — handles "event: foo\ndata: {...}" pairs
// =====================================================================
function parseSseBlock(block: string): { event: string; data: Record<string, unknown> } | null {
  const lines = block.split('\n').filter(l => l.length > 0)
  if (lines.length === 0) return null
  let event = 'message'
  let data = ''
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data += line.slice(5).trim()
  }
  if (!data) return null
  try {
    return { event, data: JSON.parse(data) as Record<string, unknown> }
  } catch {
    return null
  }
}
