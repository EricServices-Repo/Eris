import { describe, expect, it } from 'vitest'
import { intentPlaybook, isReadOnlyChat, READ_AGENT_PROMPT, TOOLS_PROMPT } from '../electron/main/services/agent/prompts'
import agents from '../resources/agents.json'

describe('TOOLS_PROMPT', () => {
  it('is a detailed worker prompt with inventory and playbooks', () => {
    const required = [
      'ROLE',
      'TOOL CALL FORMAT',
      'WHEN TO USE WHICH TOOL',
      'QUALITY BAR',
      'tree',
      'search_replace',
      'semantic_search',
      'find_references',
      'ask_user',
      'delegate_to_agent',
      'Never ask the user for project structure'
    ]
    for (const token of required) {
      expect(TOOLS_PROMPT, `missing ${token}`).toContain(token)
    }
    expect(TOOLS_PROMPT.length).toBeGreaterThan(2500)
  })
})

describe('intentPlaybook', () => {
  it('returns intent-specific guidance', () => {
    expect(intentPlaybook('review', false)).toMatch(/REVIEW PLAYBOOK/i)
    expect(intentPlaybook('edit', false)).toMatch(/EDIT PLAYBOOK/i)
    expect(intentPlaybook('edit', true)).toMatch(/GREENFIELD/i)
    expect(intentPlaybook('explore', false)).toMatch(/EXPLORE PLAYBOOK/i)
    expect(intentPlaybook('explore', false)).toMatch(/Do not edit/i)
  })
})

describe('read-only chat prompt', () => {
  it('answers instead of scaffolding files', () => {
    expect(isReadOnlyChat({ toolPolicy: 'read', intent: 'explore' })).toBe(true)
    expect(isReadOnlyChat({ toolPolicy: 'edit', intent: 'edit' })).toBe(false)
    expect(READ_AGENT_PROMPT).toMatch(/Do not create, edit, or delete/)
    expect(READ_AGENT_PROMPT).not.toMatch(/scaffold a real runnable/)
  })
})

describe('builtin agent system prompts', () => {
  it('gives Composer and specialists detailed mission/method prompts', () => {
    expect(agents.orchestrator.systemPrompt).toMatch(/STEPS/)
    expect(agents.orchestrator.systemPrompt.length).toBeGreaterThan(200)
    for (const sub of agents.subagents) {
      expect(sub.systemPrompt.length, sub.id).toBeGreaterThan(80)
      expect(sub.systemPrompt, sub.id).toMatch(/STEPS/)
    }
  })
})
