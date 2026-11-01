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
  isAutoModelChoice,
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
    ['explain this function', 'ask', 'explore'],
    ['implement a login form', 'agent', 'edit'],
    [
      'Can you show me how to add optimistic updates for a list of items with Redis for caching?',
      'agent',
      'edit'
    ],
    [
      'I need to implement transactional emails using templates with good test coverage. How would you approach it?',
      'agent',
      'edit'
    ],
    [
      "What's a pragmatic way to add search that supports filters, sorting, and highlighting in an existing codebase?",
      'agent',
      'answer'
    ],
    ['search for the authentication middleware', 'agent', 'explore'],
    ['where is AuthService defined?', 'agent', 'explore'],
    ['code review this PR', 'agent', 'review'],
    ['Review the website build\nRecommend 5 improvements', 'agent', 'review'],
    ['Recommend 5 improvements to the website', 'agent', 'review'],
    ['Review the code and suggest improvements', 'agent', 'review'],
    ['Review the project and implement the improvements', 'agent', 'edit'],
    ['Make all of those 5 improvements', 'agent', 'edit'],
    ['Edit src/retry.ts to set MAX_RETRIES to 4. Verify the change.', 'agent', 'edit'],
    ['run npm test', 'agent', 'run'],
    ['how does the app work?', 'agent', 'explore'],
    ['how do I launch this app?', 'agent', 'run'],
    ['Make it so it works', 'agent', 'edit'],
    ['fix the bug in the parser code', 'agent', 'edit'],
    [
      'Build a OSX App to review images, it should be able to tell if a car is in the photo or not',
      'agent',
      'edit'
    ],
    ['create me an electron desktop app for photo review', 'agent', 'edit'],
    ['make a new project that classifies images', 'agent', 'edit'],
    ['scaffold a macOS SwiftUI image viewer', 'agent', 'edit'],
    ['review the project folder, make improvements to the calculator', 'agent', 'edit'],
    ['review the project folder', 'agent', 'review'],
    ['Review this project, what does it do?', 'agent', 'explore'],
    ['Review the internet, who is Steve Embling', 'agent', 'explore'],
    ['Review the internet, who is Steve Embling', 'ask', 'explore'],
    ['improve the calculator UI', 'agent', 'edit'],
    ['review the airbnb website, what 3 improvements should we make?', 'agent', 'review'],
    ['Review the code, improve it for the AirBNB website', 'agent', 'review'],
    ['what 3 improvements should we make?', 'agent', 'review']
  ] as const)('%s (%s) → %s', (text, mode, intent) => {
    expect(classifyIntent(text, mode)).toBe(intent)
  })
})

describe('effectiveToolPolicy', () => {
  it('is min(agent ceiling, intent floor)', () => {
    expect(effectiveToolPolicy(agent('full'), 'capability', 'agent')).toBe('none')
    // tools:none specialists must not strip explore/edit/run floors
    expect(effectiveToolPolicy(agent('none'), 'edit', 'agent')).toBe('edit')
    expect(effectiveToolPolicy(agent('none'), 'explore', 'agent')).toBe('read')
    expect(effectiveToolPolicy(agent('read'), 'edit', 'agent')).toBe('read')
    expect(effectiveToolPolicy(agent('full'), 'edit', 'agent')).toBe('edit')
    expect(effectiveToolPolicy(agent('full'), 'run', 'agent')).toBe('full')
  })

  it('limits Ask mode to read tools', () => {
    expect(effectiveToolPolicy(agent('full'), 'explore', 'ask')).toBe('read')
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

  it('keeps Composer Full selected for Cloud Agents', () => {
    const r = resolveModelRoles({
      selectedModel: 'builtin:composer',
      intent: 'edit',
      toolPolicy: 'edit',
      preferEscalate: true
    })
    expect(r.chat).toBe('builtin:composer')
    expect(r.tools).toBe('builtin:composer')
    expect(r.escalateToFull).toBe(false)
    expect(r.error).toBeUndefined()
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

  it('keeps Composer Full even when Lite is not installed', () => {
    ready.delete('builtin:composer-lite')
    const r = resolveModelRoles({
      selectedModel: 'builtin:composer',
      intent: 'answer',
      toolPolicy: 'none',
      preferEscalate: true
    })
    expect(r.chat).toBe('builtin:composer')
    expect(r.error).toBeUndefined()
  })
})

describe('isAutoModelChoice', () => {
  it('treats an empty or Auto selection as routing', () => {
    expect(isAutoModelChoice('')).toBe(true)
    expect(isAutoModelChoice('auto')).toBe(true)
    expect(isAutoModelChoice('local:qwen3-32b')).toBe(false)
    expect(isAutoModelChoice('builtin:composer')).toBe(false)
  })
})

describe('planChatTurn', () => {
  const base = {
    workspacePath: null,
    getSecret: () => null
  }

  it('runs Composer Full on this Mac when Cloud Composer is turned off and Full is downloaded', async () => {
    const settings = structuredClone(getDefaults())
    settings.agent.routing.useLocalComposerFull = true
    const plan = await planChatTurn({
      ...base,
      settings,
      context: {
        text: 'implement a login form',
        selectedModel: 'auto',
        mode: 'agent'
      }
    })
    expect(plan.models.chat).toBe('builtin:composer')
    expect(plan.cloudPreferred).toBe(false)
  })

  it('keeps Cloud Composer when Full is not downloaded', async () => {
    ready.delete('builtin:composer')
    const settings = structuredClone(getDefaults())
    settings.agent.routing.useLocalComposerFull = true
    const plan = await planChatTurn({
      ...base,
      workspacePath: '/workspace',
      settings,
      context: {
        text: 'implement a login form',
        selectedModel: 'auto',
        mode: 'agent'
      }
    })
    expect(plan.models.chat).toBe('builtin:composer')
    expect(plan.cloudPreferred).toBe(true)
  })

  it('searches the web for a person instead of answering with no tools', async () => {
    const plan = await planChatTurn({
      ...base,
      settings: getDefaults(),
      context: {
        text: 'Review the internet, who is Steve Embling',
        selectedModel: 'builtin:composer-lite',
        mode: 'agent'
      }
    })
    expect(plan.agentId).toBe('explainer')
    expect(plan.intent).toBe('explore')
    expect(plan.toolPolicy).toBe('read')
    expect(plan.requiresTools).toBe(true)
  })

  it('runs agent turns on Composer even when another model is selected', async () => {
    const plan = await planChatTurn({
      ...base,
      settings: getDefaults(),
      context: {
        text: 'implement a login form',
        selectedModel: 'local:qwen3-32b',
        mode: 'agent'
      }
    })
    expect(plan.models.chat).toBe('local:qwen3-32b')
    expect(plan.models.tools).toBe('local:qwen3-32b')
  })

  it('leaves Ask mode on the selected model', async () => {
    const plan = await planChatTurn({
      ...base,
      settings: getDefaults(),
      context: {
        text: 'explain how routing works',
        selectedModel: 'gpt-4o',
        mode: 'ask'
      }
    })
    expect(plan.models.chat).toBe('gpt-4o')
  })

  it('uses Composer Full when Auto handles an edit and Cloud is allowed', async () => {
    const plan = await planChatTurn({
      ...base,
      workspacePath: '/workspace',
      settings: getDefaults(),
      context: {
        text: 'implement a login form',
        selectedModel: 'auto',
        mode: 'agent'
      }
    })
    expect(plan.agentId).toBe('composer')
    expect(plan.models.chat).toBe('builtin:composer')
    expect(plan.cloudPreferred).toBe(true)
  })

  it('assigns Composer to edits and does not steal them for Coder', async () => {
    const plan = await planChatTurn({
      ...base,
      settings: getDefaults(),
      context: {
        text: 'implement a login form',
        selectedModel: 'builtin:composer-lite',
        mode: 'agent'
      }
    })
    expect(plan.agentId).toBe('composer')
    expect(plan.intent).toBe('edit')
    expect(plan.toolPolicy).toBe('edit')
  })

  it('assigns Reviewer, Explainer, and Fast from the message', async () => {
    const review = await planChatTurn({
      ...base,
      settings: getDefaults(),
      context: {
        text: 'code review this PR',
        selectedModel: 'builtin:composer-lite',
        mode: 'agent'
      }
    })
    expect(review.agentId).toBe('reviewer')
    expect(review.toolPolicy).toBe('read')

    const airbnbReview = await planChatTurn({
      ...base,
      settings: getDefaults(),
      context: {
        text: 'Review the code, improve it for the AirBNB website',
        selectedModel: 'builtin:composer-lite',
        mode: 'agent'
      }
    })
    expect(airbnbReview.intent).toBe('review')
    expect(airbnbReview.agentId).toBe('reviewer')
    expect(airbnbReview.toolPolicy).toBe('read')

    const explain = await planChatTurn({
      ...base,
      settings: getDefaults(),
      context: {
        text: 'explain how routing works in this app',
        selectedModel: 'builtin:composer-lite',
        mode: 'agent'
      }
    })
    expect(explain.agentId).toBe('explainer')
    expect(explain.toolPolicy).toBe('read')

    const lookup = await planChatTurn({
      ...base,
      settings: getDefaults(),
      context: {
        text: 'where is AuthService defined?',
        selectedModel: 'builtin:composer-lite',
        mode: 'agent'
      }
    })
    expect(lookup.agentId).toBe('fast')
    expect(lookup.toolPolicy).toBe('read')
  })

  it('routes mutating requests to an editing agent even when a read-only agent is pinned', async () => {
    const plan = await planChatTurn({
      ...base,
      settings: getDefaults(),
      context: {
        text: 'implement a login form',
        selectedModel: 'builtin:composer-lite',
        mode: 'agent',
        manualAgentId: 'reviewer'
      }
    })
    expect(plan.agentId).toBe('composer')
    expect(plan.toolPolicy).toBe('edit')
  })

  it('answers capability questions without tools', async () => {
    const plan = await planChatTurn({
      ...base,
      settings: getDefaults(),
      context: {
        text: 'What models do you have access to?',
        selectedModel: 'builtin:composer-lite',
        mode: 'agent'
      }
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
        text: 'what is 2 plus 2?',
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
      context: {
        text: 'Tell me about   the parser',
        selectedModel: 'builtin:composer-lite',
        mode: 'agent'
      }
    })
    expect(plan.method).toBe('learned')
    expect(plan.requiresTools).toBe(true)
  })
})
