import { describe, expect, it } from 'vitest'
import { chatAgentForTurn, CHAT_AGENT_CONTRACTS } from '../src/shared/agent-contract'

describe('chat agent contract', () => {
  it('lets Auto choose four roles and keeps Coder for pin or delegate', () => {
    const auto = CHAT_AGENT_CONTRACTS.filter((agent) => agent.auto).map((agent) => agent.id)
    expect(auto).toEqual(['composer', 'explainer', 'reviewer', 'fast'])
    expect(CHAT_AGENT_CONTRACTS.find((agent) => agent.id === 'coder')?.auto).toBe(false)
  })

  it('maps a turn onto one role', () => {
    expect(chatAgentForTurn({ mode: 'agent', intent: 'edit', text: 'fix the parser' })).toBe(
      'composer'
    )
    expect(chatAgentForTurn({ mode: 'agent', intent: 'run', text: 'run npm test' })).toBe(
      'composer'
    )
    expect(chatAgentForTurn({ mode: 'agent', intent: 'review', text: 'code review this PR' })).toBe(
      'reviewer'
    )
    expect(
      chatAgentForTurn({ mode: 'agent', intent: 'answer', text: 'explain how the router works' })
    ).toBe('explainer')
    expect(
      chatAgentForTurn({ mode: 'agent', intent: 'explore', text: 'where is AuthService defined?' })
    ).toBe('fast')
    expect(chatAgentForTurn({ mode: 'ask', intent: 'answer', text: 'how does this app work?' })).toBe(
      'explainer'
    )
  })
})
