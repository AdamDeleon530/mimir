import Anthropic from '@anthropic-ai/sdk'
import { MIMIR_SYSTEM_PROMPT } from '~/server/utils/system-prompt'
import { MIMIR_TOOLS, executeToolCall } from '~/server/utils/tools'

interface ChatRequest {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
}

export default defineEventHandler(async (event) => {
  // Auth gate — must have valid session cookie
  const session = getCookie(event, 'mimir-session')
  if (!session) throw createError({ statusCode: 401, message: 'unauthorized' })

  const body = await readBody<ChatRequest>(event)
  if (!body?.messages?.length) {
    throw createError({ statusCode: 400, message: 'messages array required' })
  }

  const config = useRuntimeConfig()
  if (!config.anthropicApiKey) {
    throw createError({ statusCode: 500, message: 'NUXT_ANTHROPIC_API_KEY not configured' })
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey })

  // Conversation loop — handles tool use in a multi-turn agentic pattern.
  // Caps at 6 turns to prevent runaway tool-calling on a bad day.
  const conversation: Anthropic.MessageParam[] = body.messages.map(m => ({
    role: m.role,
    content: m.content,
  }))

  const MAX_TURNS = 6
  const toolUseTrace: Array<{ name: string; input: unknown; result: unknown }> = []

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      system: MIMIR_SYSTEM_PROMPT,
      tools: MIMIR_TOOLS,
      messages: conversation,
    })

    // Add the assistant turn to the conversation
    conversation.push({ role: 'assistant', content: response.content })

    // Did Claude call any tools? If so, execute and feed results back.
    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    )

    if (toolUses.length === 0) {
      // Pure text response — done.
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim()
      return {
        reply: text || 'the watch is silent.',
        toolUse: toolUseTrace,
      }
    }

    // Execute each tool call, then add results back as a user-role message
    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const tu of toolUses) {
      const result = await executeToolCall(tu.name, tu.input as Record<string, unknown>)
      toolUseTrace.push({ name: tu.name, input: tu.input, result })
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      })
    }
    conversation.push({ role: 'user', content: toolResults })
  }

  // Exceeded MAX_TURNS — bail with whatever we've got.
  return {
    reply: 'the consultation grows long. ask again, more simply.',
    toolUse: toolUseTrace,
  }
})
