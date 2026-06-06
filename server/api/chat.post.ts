/**
 * POST /api/chat
 *
 * Streaming chat endpoint. Emits server-sent events as the agentic loop runs:
 *   - event: text       → token delta from Claude
 *   - event: tool_start → tool name + input ("calling search_leads…")
 *   - event: tool_end   → tool result preview (truncated)
 *   - event: done       → final reply text + full trace
 *   - event: error      → fatal error
 *
 * Client consumes via fetch + ReadableStream — see composables/useMimir.ts.
 */
import Anthropic from '@anthropic-ai/sdk'
import { MIMIR_SYSTEM_PROMPT } from '~/server/utils/system-prompt'
import { MIMIR_TOOLS, executeToolCall } from '~/server/utils/tools'
import { checkDailyBudget, recordAnthropicUsage } from '~/server/utils/cost-tracker'
import { appendTurns, sessionIdFromCookie } from '~/server/utils/conversation-memory'

interface ChatRequest {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
}

const MAX_TURNS = 6

export default defineEventHandler(async (event) => {
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

  setResponseHeader(event, 'Content-Type', 'text/event-stream')
  setResponseHeader(event, 'Cache-Control', 'no-cache, no-transform')
  setResponseHeader(event, 'Connection', 'keep-alive')
  setResponseHeader(event, 'X-Accel-Buffering', 'no')

  const client = new Anthropic({ apiKey: config.anthropicApiKey })
  const conversation: Anthropic.MessageParam[] = body.messages.map(m => ({
    role: m.role,
    content: m.content,
  }))

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      function emit(ev: string, data: Record<string, unknown>): void {
        controller.enqueue(encoder.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`))
      }

      const toolUseTrace: Array<{ name: string; input: unknown; result: unknown }> = []
      let finalReply = ''

      try {
        // Budget check BEFORE any model call
        const budget = await checkDailyBudget()
        if (!budget.allowed) {
          emit('done', {
            reply: `we've hit the daily budget. spent $${budget.spent_usd.toFixed(2)} of $${budget.cap_usd.toFixed(2)}. ask again tomorrow, or raise NUXT_DAILY_BUDGET_USD.`,
            toolUse: toolUseTrace,
          })
          controller.close()
          return
        }
        if (budget.at_warning_threshold) {
          emit('text', { delta: '' })  // no-op, but a signal point
        }

        for (let turn = 0; turn < MAX_TURNS; turn++) {
          // Stream this turn's response from Anthropic
          const turnStream = await client.messages.stream({
            model: 'claude-sonnet-4-6',
            max_tokens: 800,
            system: MIMIR_SYSTEM_PROMPT,
            tools: MIMIR_TOOLS,
            messages: conversation,
          })

          // Emit text deltas as they arrive
          turnStream.on('text', (textDelta: string) => {
            finalReply += textDelta
            emit('text', { delta: textDelta })
          })

          const finalMessage = await turnStream.finalMessage()
          conversation.push({ role: 'assistant', content: finalMessage.content })

          // Record usage from this turn
          await recordAnthropicUsage({
            model: 'claude-sonnet-4-6',
            input_tokens: finalMessage.usage.input_tokens,
            output_tokens: finalMessage.usage.output_tokens,
            caller: 'chat',
          })

          const toolUses = finalMessage.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
          )

          if (toolUses.length === 0) {
            // No tool calls — turn is final
            const reply = finalReply.trim()
            // Persist this exchange (last user turn + assistant reply) to KV
            try {
              const lastUser = body.messages[body.messages.length - 1]
              if (lastUser?.role === 'user') {
                await appendTurns(sessionIdFromCookie(session), [
                  { role: 'user', content: lastUser.content, at: new Date().toISOString() },
                  { role: 'assistant', content: reply, at: new Date().toISOString() },
                ])
              }
            } catch { /* persistence is best-effort */ }
            emit('done', { reply, toolUse: toolUseTrace })
            controller.close()
            return
          }

          // Execute each tool call, announcing start + end
          const toolResults: Anthropic.ToolResultBlockParam[] = []
          for (const tu of toolUses) {
            emit('tool_start', { name: tu.name, input: tu.input })
            const result = await executeToolCall(tu.name, tu.input as Record<string, unknown>)
            toolUseTrace.push({ name: tu.name, input: tu.input, result })

            const resultStr = JSON.stringify(result)
            emit('tool_end', {
              name: tu.name,
              preview: resultStr.length > 400 ? resultStr.slice(0, 400) + '…' : resultStr,
            })

            toolResults.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: resultStr,
            })
          }
          conversation.push({ role: 'user', content: toolResults })
          // Reset finalReply for the next turn — it accumulates per-turn deltas;
          // Mimir's eventual textual response is the LAST turn's emitted text.
          finalReply = ''
        }

        // Bail — too many turns
        emit('done', {
          reply: 'the consultation grows long. ask again, more simply.',
          toolUse: toolUseTrace,
        })
        controller.close()
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error'
        emit('error', { message: msg })
        controller.close()
      }
    },
  })

  return stream
})
