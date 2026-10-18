import type { AppSettings, ChatPromptInput } from '../../../src/shared/settings-schema'
import { contractForAgent } from '../../../src/shared/agent-contract'
import { findAgent, getProjectAgents } from './agents'
import { formatAgentDiscussions } from './agent-discussions'
import { listBackgroundJobs } from './background-agents'
import { loadWorkspaceRules } from './chats'
import { languageFromPath, readTextFile } from './files'
import { loadSkillsPrompt } from './skills'
import { formatWorkspaceContextPrompt } from './workspace-context'

export type BuiltChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…` : text
}

function workspaceDiscussions(workspacePath: string | null, query: string): string {
  let jobs: Parameters<typeof formatAgentDiscussions>[0]['jobs'] = []
  try {
    jobs = listBackgroundJobs(workspacePath).slice(0, 8).map((job) => ({
      id: job.id,
      agentName: job.agentName,
      goal: job.goal,
      answer: job.answer,
      status: job.status,
      sourceThreadId: job.sourceThreadId
    }))
  } catch {
    jobs = []
  }
  return formatAgentDiscussions({ jobs, query, maxItems: 3, maxChars: 2200 })
}

function compactHistory(
  history: ChatPromptInput['history'],
  maxChars: number
): { recent: ChatPromptInput['history']; summary: string } {
  const messages = history.filter((message) => message.role === 'user' || message.role === 'assistant')
  const selected: ChatPromptInput['history'] = []
  let used = 0
  let firstSelected = messages.length
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    const content = message.content || ''
    const remaining = maxChars - used
    if (remaining <= 0) break
    const clipped = content.length > remaining ? `${content.slice(0, remaining)}…` : content
    selected.unshift({ ...message, content: clipped })
    used += clipped.length
    firstSelected = index
    if (clipped.length < content.length) break
  }

  const older = messages.slice(0, firstSelected)
  const summary = older
    .slice(-12)
    .map((message) => {
      const who = message.role === 'user' ? 'User' : message.agentName || 'Assistant'
      const excerpt = message.content.replace(/\s+/g, ' ').trim().slice(0, 240)
      return excerpt ? `${who}: ${excerpt}` : ''
    })
    .filter(Boolean)
    .join('\n')
    .slice(-Math.min(2200, Math.floor(maxChars / 3)))
  return { recent: selected, summary }
}

function fence(label: string, path: string, language: string, content: string, max: number) {
  return `${label}: ${path}\n\`\`\`${language}\n${content.slice(0, max)}\n\`\`\``
}

/** Assemble system context + history + user turn for a chat request. */
export function buildChatMessages(
  workspacePath: string | null,
  settings: AppSettings,
  input: ChatPromptInput
): BuiltChatMessage[] {
  // Agent turns are leaner so builtin 4k/8k windows keep room for tool output.
  const lean = input.mode === 'agent'
  const rulesCap = lean ? 1800 : 6000
  const openCap = lean ? 2500 : 10000
  const importCap = lean ? 3000 : 16000
  const importMaxFiles = lean ? 2 : 8

  const agent = findAgent(workspacePath, input.agentId)
  const isOrchestrator = getProjectAgents(workspacePath).orchestrator.id === input.agentId
  const contract = contractForAgent(input.agentId)
  const parts: string[] = [
    contract
      ? `AGENT CONTRACT — ${contract.name}\nJob: ${contract.job}\nTools: ${contract.tools}. ${contract.doesNot}\nDone when: ${contract.done}`
      : '',
    settings.agent.systemPrompt.slice(0, lean ? 2000 : 5000),
    agent
      ? `You are the “${agent.name}” ${isOrchestrator ? 'orchestrator' : 'subagent'}.\n${agent.systemPrompt.slice(0, lean ? 2800 : 8000)}`
      : `You are the “${input.agentName || input.agentId}” agent.`
  ].filter(Boolean)

  let rules = ''
  try {
    rules = loadWorkspaceRules(workspacePath)
  } catch {
    rules = ''
  }
  if (rules) parts.push(`Workspace rules:\n${cap(rules, rulesCap)}`)

  let pin = ''
  try {
    pin = formatWorkspaceContextPrompt(workspacePath)
  } catch {
    pin = ''
  }
  if (pin) parts.push(cap(pin, 900))

  if (input.skillIds.length > 0) {
    let skillsPrompt = ''
    try {
      skillsPrompt = loadSkillsPrompt(workspacePath, input.skillIds)
    } catch {
      skillsPrompt = ''
    }
    if (skillsPrompt) {
      parts.push(
        `Active skills for this message (follow these instructions):\n${skillsPrompt.slice(0, lean ? 2500 : 12000)}`
      )
    }
  }

  if (settings.agent.includeOpenFiles && input.openFile) {
    const f = input.openFile
    parts.push(fence('Active file', f.path, f.language || languageFromPath(f.path), f.content, openCap))
  }

  const imported: string[] = []
  for (const file of input.attachments.slice(0, importMaxFiles)) {
    if (typeof file.content === 'string') {
      imported.push(
        fence('Imported file', file.path, file.language || languageFromPath(file.path), file.content, importCap)
      )
      continue
    }
    try {
      const read = readTextFile(file.path)
      imported.push(fence('Imported file', read.path, languageFromPath(read.path), read.content, importCap))
    } catch {
      imported.push(`Imported file: ${file.path}\n(Unable to read file)`)
    }
  }
  if (imported.length > 0) {
    parts.push(`User-imported files for this message:\n\n${imported.join('\n\n')}`)
  }

  const historyBudget = lean ? 6000 : 24000
  const { recent: history, summary: historySummary } = compactHistory(input.history, historyBudget)
  if (historySummary) {
    parts.push(`Earlier conversation summary (older turns condensed):\n${historySummary}`)
  }
  const userContent =
    input.attachments.length > 0
      ? `${input.text}\n\n(See system context for ${input.attachments.length} imported file(s).)`
      : input.text
  const discussions = workspaceDiscussions(workspacePath, input.text)
  const discussionMessage = discussions
    ? {
        role: 'user' as const,
        content:
          `Relevant recent background-agent context. Treat it as a lead and verify details before relying on it.\n\n${discussions}`
      }
    : null

  return [
    { role: 'system' as const, content: parts.join('\n\n') },
    ...(discussionMessage ? [discussionMessage] : []),
    ...history.map((m) => ({
      role: m.role,
      content:
        m.role === 'assistant' && m.agentName ? `[${m.agentName}]\n${m.content}` : m.content
    })),
    { role: 'user' as const, content: userContent }
  ]
}
