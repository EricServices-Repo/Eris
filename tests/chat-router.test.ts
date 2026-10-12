import { beforeEach, describe, expect, it, vi } from 'vitest'

const ready = new Set<string>(['builtin:composer-lite', 'builtin:composer'])

vi.mock('../electron/main/services/builtin-model', () => ({
  isBuiltinRef: (m: string) => m.startsWith('builtin:'),
  isExactBuiltinReady: (m: string) => ready.has(m),
  resolveExactBuiltinRef: (m: string) => (ready.has(m) ? m : null)
}))

vi.mock('../electron/main/services/chat-runtime', () => ({
  streamModelChat: vi.fn()
}))

import {
  classifyIntent,
  effectiveToolPolicy,
  filterToolsByPolicy,
  isErisCapabilityQuestion,
  planChatTurn,
  resolveModelRoles,
  toolAllowedByPolicy
} from '../electron/main/services/chat-router'
import { recordRoutingCorrection } from '../electron/main/services/routing-feedback'
import { getDefaults } from '../electron/main/services/settings'
import type { AgentDefinition } from '../src/shared/settings-schema'

function agent(tools: AgentDefinition['tools']): AgentDefinition {
  return {
    id: 'x',
    name: 'X',
    description: '',
    model: '',
    temperature: null,
    enabled: true,
    builtin: true,
    systemPrompt: '',
    keywords: [],
    tools,
    preferEscalate: true
  }
}

beforeEach(() => {
  ready.clear()
  ready.add('builtin:composer-lite')
  ready.add('builtin:composer')
})

describe('isErisCapabilityQuestion', () => {
  it('detects questions about Eris models', () => {
    expect(isErisCapabilityQuestion('What models do you have access to?')).toBe(true)
    expect(isErisCapabilityQuestion('is ollama connected and ready?')).toBe(true)
    expect(isErisCapabilityQuestion('which AI models are installed')).toBe(true)
  })

  it('ignores unrelated text', () => {
    expect(isErisCapabilityQuestion('fix the login bug')).toBe(false)
    expect(isErisCapabilityQuestion('')).toBe(false)
  })
})

describe('classifyIntent', () => {
  it.each([
    ['What models do you have access to?', 'agent', 'capability'],
    ['What models do you have access to?', 'ask', 'capability'],
    ['explain this function', 'ask', 'answer'],
    ['implement a login form', 'agent', 'edit'],
    ['where is AuthService defined?', 'agent', 'explore'],
    ['code review this PR', 'agent', 'review'],
    ['run npm test', 'agent', 'run'],
    ['how does the app work?', 'agent', 'answer'],
    ['fix the bug in the parser code', 'agent', 'edit'],
    [
      'Build a OSX App to review images, it should be able to tell if a car is in the photo or not',
      'agent',
      'edit'
    ],
    ['create me an electron desktop app for photo review', 'agent', 'edit'],
    ['make a new project that classifies images', 'agent', 'edit'],
    ['scaffold a macOS SwiftUI image viewer', 'agent', 'edit']
  ] as const)('%s (%s) → %s', (text, mode, intent) => {
    expect(classifyIntent(text, mode)).toBe(intent)
  })
})

describe('effectiveToolPolicy', () => {
  it('is min(agent ceiling, intent floor)', () => {
    expect(effectiveToolPolicy(agent('full'), 'capability', 'agent')).toBe('none')
    expect(effectiveToolPolicy(agent('none'), 'edit', 'agent')).toBe('none')
    expect(effectiveToolPolicy(agent('read'), 'edit', 'agent')).toBe('read')
    expect(effectiveToolPolicy(agent('full'), 'edit', 'agent')).toBe('edit')
    expect(effectiveToolPolicy(agent('full'), 'run', 'agent')).toBe('full')
  })

  it('Ask mode never gets tools', () => {
    expect(effectiveToolPolicy(agent('full'), 'explore', 'ask')).toBe('none')
  })
})

describe('tool policy filtering', () => {
  it('limits tools per ceiling', () => {
    expect(toolAllowedByPolicy('read_file', 'read')).toBe(true)
    expect(toolAllowedByPolicy('write_file', 'read')).toBe(false)
    expect(toolAllowedByPolicy('write_file', 'edit')).toBe(true)
    expect(toolAllowedByPolicy('run', 'edit')).toBe(false)
    expect(toolAllowedByPolicy('run', 'full')).toBe(true)
    expect(toolAllowedByPolicy('git_sync', 'edit')).toBe(false)
    expect(toolAllowedByPolicy('anything', 'none')).toBe(false)
  })

  it('filters OpenAI tool definitions', () => {
    const tools = ['tree', 'write_file', 'run'].map((name) => ({ function: { name } }))
    expect(filterToolsByPolicy(tools, 'read').map((t) => t.function.name)).toEqual(['tree'])
    expect(filterToolsByPolicy(tools, 'none')).toEqual([])
  })
})

describe('resolveModelRoles', () => {
  it('keeps local chat and tools on Composer Lite (Full is Cloud Agents only)', () => {
    const r = resolveModelRoles({
      selectedModel: 'builtin:composer-lite',
      intent: 'edit',
      toolPolicy: 'edit',
      preferEscalate: true
    })
    expect(r).toMatchObject({
      chat: 'builtin:composer-lite',
      tools: 'builtin:composer-lite',
      escalateToFull: false
    })
  })

  it('remaps selected Composer Full to Lite for local runs', () => {
    const r = resolveModelRoles({
      selectedModel: 'builtin:composer',
      intent: 'edit',
      toolPolicy: 'edit',
      preferEscalate: true
    })
    expect(r.chat).toBe('builtin:composer-lite')
    expect(r.tools).toBe('builtin:composer-lite')
    expect(r.escalateToFull).toBe(false)
  })

  it('never swaps external models', () => {
    const r = resolveModelRoles({
      selectedModel: 'qwen3:0.6b',
      intent: 'edit',
      toolPolicy: 'edit',
      preferEscalate: true
    })
    expect(r).toMatchObject({ chat: 'qwen3:0.6b', tools: 'qwen3:0.6b', escalateToFull: false })
  })

  it('errors when Full is selected but Lite is not installed', () => {
    ready.delete('builtin:composer-lite')
    const r = resolveModelRoles({
      selectedModel: 'builtin:composer',
      intent: 'answer',
      toolPolicy: 'none',
      preferEscalate: true
    })
    expect(r.error).toMatch(/Cloud Agents|Composer Lite/)
  })
})

describe('planChatTurn', () => {
  const base = {
    workspacePath: null,
    getSecret: () => null
  }

  it('answers capability questions without tools', async () => {
    const plan = await planChatTurn({
      ...base,
      settings: getDefaults(),
      context: { text: 'What models do you have access to?', selectedModel: 'builtin:composer-lite', mode: 'agent' }
    })
    expect(plan.intent).toBe('capability')
    expect(plan.toolPolicy).toBe('none')
    expect(plan.requiresTools).toBe(false)
  })

  it('forceRoute=tools upgrades an answer turn to an edit turn', async () => {
    const plan = await planChatTurn({
      ...base,
      settings: getDefaults(),
      context: {
        text: 'how does the app work?',
        selectedModel: 'builtin:composer-lite',
        mode: 'ask',
        forceRoute: 'tools'
      }
    })
    expect(plan.mode).toBe('agent')
    expect(plan.intent).toBe('edit')
    expect(plan.method).toBe('override')
    expect(plan.classifiedIntent).toBe('answer')
    expect(plan.requiresTools).toBe(true)
    // Read-only specialists hand off to the fallback agent so edits are possible
    expect(plan.toolPolicy).toBe('edit')
  })

  it('forceRoute=answer drops tools', async () => {
    const plan = await planChatTurn({
      ...base,
      settings: getDefaults(),
      context: {
        text: 'implement a login form',
        selectedModel: 'builtin:composer-lite',
        mode: 'agent',
        forceRoute: 'answer'
      }
    })
    expect(plan.intent).toBe('answer')
    expect(plan.toolPolicy).toBe('none')
  })

  it('applies a learned correction for the same message', async () => {
    recordRoutingCorrection({
      text: 'tell me about the parser',
      from: 'answer',
      to: 'tools',
      agentId: 'composer'
    })
    const plan = await planChatTurn({
      ...base,
      settings: getDefaults(),
      context: { text: 'Tell me about   the parser', selectedModel: 'builtin:composer-lite', mode: 'agent' }
    })
    expect(plan.method).toBe('learned')
    expect(plan.requiresTools).toBe(true)
  })
})
