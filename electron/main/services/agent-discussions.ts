import type { ChatThread } from '../../../src/shared/settings-schema'

export interface DiscussionJob {
  id: string
  agentName?: string
  goal: string
  answer: string
  status: string
  sourceThreadId?: string | null
}

/** Every other chat and background agent run, in full. */
export function formatAgentDiscussions(input: {
  threads: ChatThread[]
  currentThreadId?: string | null
  jobs?: DiscussionJob[]
}): string {
  const blocks: string[] = []
  const seenThreads = new Set<string>()
  for (const thread of input.threads) {
    if (input.currentThreadId && thread.id === input.currentThreadId) continue
    seenThreads.add(thread.id)
    const lines = thread.messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => {
        const who = message.role === 'assistant' ? message.agentName || 'assistant' : 'user'
        const delegated = message.delegations?.length
          ? `\nDelegated:\n${message.delegations
              .map((item) => `${item.agentName}: ${item.result}`)
              .join('\n')}`
          : ''
        return `${who}: ${message.content}${delegated}`
      })
    if (lines.length === 0) continue
    blocks.push(`## ${thread.title || 'Chat'}\n${lines.join('\n\n')}`)
  }
  for (const job of input.jobs ?? []) {
    if (job.sourceThreadId && seenThreads.has(job.sourceThreadId)) continue
    if (!job.goal.trim() && !job.answer.trim()) continue
    blocks.push(
      `## Background ${job.agentName || 'agent'} · ${job.status}\nGoal: ${job.goal}\n\n${job.answer}`
    )
  }
  return blocks.join('\n\n')
}

/** What the previous agent already told the user, so the next turn can continue it. */
export function handoffFromMessages(
  messages: Array<{ role: string; content: string }>
): string {
  const last = [...messages].reverse().find((message) => message.role === 'assistant' && message.content.trim())
  if (!last) return ''
  const paths = [
    ...last.content.matchAll(/(?:^|[\s`'"(])([\w./-]+\.[A-Za-z0-9]{1,8})\b/g)
  ]
    .map((match) => match[1] || '')
    .filter((path) => path && !path.includes('://'))
  const files = [...new Set(paths)].slice(0, 20)
  return [
    'Previous agent turn in this chat:',
    last.content,
    files.length ? `Files cited: ${files.join(', ')}` : '',
    'Continue from that turn. If the user asks to code, implement, apply, fix, or change any of those suggestions, edit the cited files. If they ask what changed, answer from that turn. Do not ask them to repeat it.'
  ]
    .filter(Boolean)
    .join('\n')
}
