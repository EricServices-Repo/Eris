import type { ChatIntent } from './settings-schema'

/**
 * The chat roster. Auto assigns one of these from the message.
 * Coder is not chosen by Auto — pin it, or let Composer delegate to it.
 */
export interface ChatAgentContract {
  id: 'composer' | 'coder' | 'explainer' | 'reviewer' | 'fast'
  name: string
  /** One sentence the picker and the model both follow. */
  job: string
  tools: 'read' | 'edit' | 'full'
  /** True when Auto may select this agent. */
  auto: boolean
  doesNot: string
  done: string
}

export const CHAT_AGENT_CONTRACTS: ChatAgentContract[] = [
  {
    id: 'composer',
    name: 'Composer',
    job: 'Owns changes: inspect the workspace, edit it, verify, and delegate only when the work splits.',
    tools: 'full',
    auto: true,
    doesNot: 'Does not ask the user to paste files that are already in the workspace, and does not hand off a small single-file fix.',
    done: 'A short summary of files changed or what was found. Delegated work is included only after those agents finish.'
  },
  {
    id: 'coder',
    name: 'Coder',
    job: 'Implements one assigned change with a small diff. Used when pinned, or when Composer delegates.',
    tools: 'edit',
    auto: false,
    doesNot: 'Does not widen the task, open pull requests, or delegate further.',
    done: 'The assigned files are edited and, when the project has them, tests or typecheck have been run.'
  },
  {
    id: 'explainer',
    name: 'Explainer',
    job: 'Reads the workspace and explains how it actually behaves.',
    tools: 'read',
    auto: true,
    doesNot: 'Does not edit files. In Ask mode it does not call tools.',
    done: 'A short explanation with the real file paths and symbols it read.'
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    job: 'Reads the change or the project and reports bugs, risks, and missing tests.',
    tools: 'read',
    auto: true,
    doesNot: 'Does not edit. May run the project test or typecheck command. If the user wants fixes, it says to run Composer.',
    done: 'Findings with a path, what is wrong, why it matters, and a suggested fix. Ordered blockers, risks, suggestions, nits.'
  },
  {
    id: 'fast',
    name: 'Fast',
    job: 'Answers a short lookup in a few sentences, reading the workspace when the answer depends on it.',
    tools: 'read',
    auto: true,
    doesNot: 'Does not edit, plan, or write a long tour of the codebase.',
    done: 'One to three sentences with the path or symbol, or a single line saying Composer should take an edit.'
  }
]

/** “What does this project do?” — a description, not a defect review. */
export function asksWhatTheProjectDoes(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return (
    /\bwhat does (it|this) do\b/i.test(t) ||
    /\bwhat (does|is) (this|the) (project|app|application|repo|codebase|workspace)\b/i.test(t) ||
    /\b(describe|tell me about) (this |the )?(project|app|application|repo|codebase|workspace)\b/i.test(
      t
    )
  )
}

const BY_ID = new Map(CHAT_AGENT_CONTRACTS.map((c) => [c.id, c]))

export function contractForAgent(id: string | null | undefined): ChatAgentContract | null {
  if (!id) return null
  return BY_ID.get(id as ChatAgentContract['id']) ?? null
}

/**
 * Which builtin agent speaks for this chat turn.
 * Edit and run stay with Composer. Coder is never returned.
 */
export function chatAgentForTurn(options: {
  mode: 'ask' | 'agent'
  intent: ChatIntent
  text: string
}): ChatAgentContract['id'] {
  const text = options.text.trim()
  const explains = /\b(explain|how|why|overview|summarize|architecture)\b/i.test(text)
  const shortLookup =
    text.length > 0 &&
    text.length < 80 &&
    /\b(where is|which file|what file)\b/i.test(text) &&
    !explains

  if (options.mode === 'ask') {
    return shortLookup ? 'fast' : 'explainer'
  }

  if (asksWhatTheProjectDoes(text)) return 'explainer'
  if (options.intent === 'review') return 'reviewer'
  if (options.intent === 'edit' || options.intent === 'run') return 'composer'
  if (options.intent === 'explore') return shortLookup ? 'fast' : 'explainer'
  if (explains) return 'explainer'
  if (text.length > 0 && text.length < 80) return 'fast'
  return 'explainer'
}
