import type { ChatThread } from '../../../src/shared/settings-schema'

export interface DiscussionJob {
  id: string
  agentName?: string
  goal: string
  answer: string
  status: string
  sourceThreadId?: string | null
}

function clip(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > maxChars
    ? `${normalized.slice(0, Math.max(0, maxChars - 1))}…`
    : normalized
}

function relevance(text: string, terms: string[]): number {
  const lower = text.toLowerCase()
  return terms.reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0)
}

/** Compact, relevance-ranked context from other work; never inject full transcripts. */
export function formatAgentDiscussions(input: {
  threads?: ChatThread[]
  currentThreadId?: string | null
  jobs?: DiscussionJob[]
  query?: string
  maxChars?: number
  maxItems?: number
}): string {
  const maxChars = Math.max(0, input.maxChars ?? 3200)
  const maxItems = Math.max(0, input.maxItems ?? 4)
  if (maxChars === 0 || maxItems === 0) return ''
  const terms = (input.query || '')
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((term) => term.length > 2)
    .slice(0, 12)
  const candidates: Array<{ text: string; score: number; updatedAt: number }> = []
  const seenThreads = new Set<string>()
  for (const thread of input.threads ?? []) {
    if (input.currentThreadId && thread.id === input.currentThreadId) continue
    seenThreads.add(thread.id)
    const recent = thread.messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .slice(-2)
      .map((message) => {
        const who = message.role === 'assistant' ? message.agentName || 'assistant' : 'user'
        return `${who}: ${clip(message.content, 500)}`
      })
    if (recent.length === 0) continue
    const text = `## ${clip(thread.title || 'Chat', 80)}\n${recent.join('\n')}`
    const score = relevance(text, terms)
    if (terms.length > 0 && score === 0) continue
    candidates.push({ text, score, updatedAt: thread.updatedAt })
  }
  for (const job of (input.jobs ?? []).slice(0, 8)) {
    if (job.sourceThreadId && seenThreads.has(job.sourceThreadId)) continue
    if (!job.goal.trim() && !job.answer.trim()) continue
    const text =
      `## Background ${clip(job.agentName || 'agent', 50)} · ${clip(job.status, 24)}\n` +
      `Goal: ${clip(job.goal, 320)}\nResult: ${clip(job.answer, 700)}`
    const score = relevance(text, terms)
    if (terms.length > 0 && score === 0) continue
    candidates.push({ text, score, updatedAt: 0 })
  }
  candidates.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
  const output: string[] = []
  let used = 0
  for (const candidate of candidates.slice(0, maxItems)) {
    const remaining = maxChars - used
    if (remaining <= 80) break
    const text = clip(candidate.text, remaining)
    output.push(text)
    used += text.length + 2
  }
  return output.join('\n\n')
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
    'Continue from that turn. If the user asks to add, code, implement, apply, fix, or change any of those suggestions, edit the cited files. If they ask what changed, answer from that turn. Do not ask them to repeat it.'
  ]
    .filter(Boolean)
    .join('\n')
}
