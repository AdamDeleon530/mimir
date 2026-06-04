interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface ChatResponse {
  reply: string
  toolUse?: { name: string; input: unknown; result: unknown }[]
}

export function useMimir() {
  const messages = useState<Message[]>('mimir-messages', () => [])
  const sending = ref(false)
  const lastReply = ref('')

  async function send(content: string): Promise<void> {
    messages.value.push({ role: 'user', content })
    sending.value = true
    try {
      const res = await $fetch<ChatResponse>('/api/chat', {
        method: 'POST',
        body: {
          messages: messages.value.map(m => ({ role: m.role, content: m.content })),
        },
      })
      messages.value.push({ role: 'assistant', content: res.reply })
      lastReply.value = res.reply
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : 'something went wrong'
      messages.value.push({ role: 'assistant', content: `the well is murky — ${errMsg}` })
    } finally {
      sending.value = false
    }
  }

  function clear() {
    messages.value = []
    lastReply.value = ''
  }

  return { messages, sending, lastReply, send, clear }
}
