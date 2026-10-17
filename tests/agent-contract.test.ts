import { describe, expect, it } from 'vitest'
import {
  asksWhatTheProjectDoes,
  chatAgentForTurn,
  CHAT_AGENT_CONTRACTS
} from '../src/shared/agent-contract'

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
      chatAgentForTurn({
        mode: 'agent',
        intent: 'explore',
        text: 'Review this project, what does it do?'
      })
    ).toBe('explainer')
    expect(asksWhatTheProjectDoes('Review this project, what does it do?')).toBe(true)
    expect(asksWhatTheProjectDoes('code review this PR')).toBe(false)
    expect(chatAgentForTurn({
      mode: 'agent',
      intent: 'explore',
      text: 'and the tests?',
      previousAgentId: 'explainer'
    })).toBe('explainer')
    expect(chatAgentForTurn({
      mode: 'agent',
      intent: 'explore',
      text: 'fix that',
      previousAgentId: 'explainer'
    })).toBe('composer')
    expect(chatAgentForTurn({
      mode: 'agent',
      intent: 'edit',
      text: 'what did you change?',
      previousAgentId: 'composer'
    })).toBe('explainer')
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
