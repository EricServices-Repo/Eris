import type { AgentChatMessage } from './types'

/** Preserve conversational roles and remove only the final turn we will append. */
export function workerConversation(messages: AgentChatMessage[], goal: string): AgentChatMessage[] {
  const history = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({ ...message }))
  const last = history[history.length - 1]
  if (last?.role === 'user' && last.content.trim() === goal.trim()) history.pop()
  return history.map((message) =>
    message.role === 'assistant'
      ? {
          ...message,
          content: message.content
            .replace(/\n(?:\n)?\[Eris worker\][\s\S]*$/, '')
            .replace(/\nContinue from that turn\.[\s\S]*$/, '')
        }
      : message
  )
}
