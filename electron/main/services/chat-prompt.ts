import type { AppSettings, ChatPromptInput } from '../../../src/shared/settings-schema'
import { contractForAgent } from '../../../src/shared/agent-contract'
import { findAgent, getProjectAgents } from './agents'
import { formatAgentDiscussions } from './agent-discussions'
import { listBackgroundJobs } from './background-agents'
import { listChats, loadWorkspaceRules } from './chats'
import { languageFromPath, readTextFile } from './files'
import { loadSkillsPrompt } from './skills'
import { formatWorkspaceContextPrompt } from './workspace-context'

export type BuiltChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…` : text
}

function workspaceDiscussions(workspacePath: string | null, currentThreadId?: string | null): string {
  let threads: ReturnType<typeof listChats> = []
  try {
    threads = listChats(workspacePath)
  } catch {
    threads = []
  }
  let jobs: Parameters<typeof formatAgentDiscussions>[0]['jobs'] = []
  try {
    jobs = listBackgroundJobs(workspacePath).map((job) => ({
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
  return formatAgentDiscussions({ threads, currentThreadId, jobs })
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

  const history = input.history.filter((m) => m.role === 'user' || m.role === 'assistant')
  const userContent =
    input.attachments.length > 0
      ? `${input.text}\n\n(See system context for ${input.attachments.length} imported file(s).)`
      : input.text
  const discussions = workspaceDiscussions(workspacePath, input.threadId)
  const discussionMessage = discussions
    ? {
        role: 'user' as const,
        content:
          `Other agent discussions in this workspace. Use all of them. Do not ignore another agent's findings.\n\n${discussions}`
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
