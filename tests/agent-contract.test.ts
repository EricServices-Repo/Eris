import { describe, expect, it } from 'vitest'
import {
  agentForFollowUp,
  asksWhatTheProjectDoes,
  chatAgentForTurn,
  CHAT_AGENT_CONTRACTS,
  isConversationFollowUp
} from '../src/shared/agent-contract'

describe('chat agent contract', () => {
  it('lets Auto choose specialist roles and keeps Coder for pin or delegate', () => {
    const auto = CHAT_AGENT_CONTRACTS.filter((agent) => agent.auto).map((agent) => agent.id)
    expect(auto).toEqual(['composer', 'explainer', 'reviewer', 'planner', 'verifier', 'fast'])
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
    expect(
      chatAgentForTurn({
        mode: 'agent',
        intent: 'explore',
        text: 'Review the internet, who is Steve Embling'
      })
    ).toBe('explainer')
    expect(
      chatAgentForTurn({
        mode: 'agent',
        intent: 'explore',
        text: 'and the tests?',
        previousAgentId: 'explainer'
      })
    ).toBe('explainer')
    expect(
      chatAgentForTurn({
        mode: 'agent',
        intent: 'edit',
        text: 'fix that',
        previousAgentId: 'explainer'
      })
    ).toBe('composer')
    expect(
      chatAgentForTurn({
        mode: 'agent',
        intent: 'explore',
        text: 'what did you change?',
        previousAgentId: 'composer'
      })
    ).toBe('explainer')
    expect(
      chatAgentForTurn({ mode: 'agent', intent: 'answer', text: 'explain how the router works' })
    ).toBe('explainer')
    expect(
      chatAgentForTurn({ mode: 'agent', intent: 'explore', text: 'where is AuthService defined?' })
    ).toBe('fast')
    expect(
      chatAgentForTurn({
        mode: 'agent',
        intent: 'review',
        text: 'and those issues?',
        previousAgentId: 'composer'
      })
    ).toBe('reviewer')
    expect(
      chatAgentForTurn({ mode: 'ask', intent: 'answer', text: 'how does this app work?' })
    ).toBe('explainer')
  })
})

describe('follow-up routing (#504)', () => {
  const R4 = 'Add a "Clear all" button to the to-do page that removes every item from the list.'
  const R6 = 'After that, tell me in one sentence which files you changed.'

  it('does not treat a relative "that" as a reference to the previous turn', () => {
    expect(isConversationFollowUp(R4)).toBe(false)
    expect(isConversationFollowUp('Write a function that parses dates')).toBe(false)
    expect(agentForFollowUp(R4, 'reviewer', 'edit')).toBeNull()
  })

  it.each([
    'fix that', 'do that', 'apply them', 'and the tests?', 'what did you change?',
    'Add a footer to that page', 'Remove those', 'that one too', R6
  ])('still treats %j as a follow-up', (text) => {
    expect(isConversationFollowUp(text)).toBe(true)
  })

  it('moves implementation verbs to Composer', () => {
    expect(agentForFollowUp('Add a footer to that page', 'reviewer', 'edit')).toBe('composer')
    expect(agentForFollowUp('Remove those', 'reviewer', 'edit')).toBe('composer')
    expect(agentForFollowUp('fix that', 'explainer')).toBe('composer')
  })

  it('sends "which files did you change" to Explainer', () => {
    expect(agentForFollowUp(R6, 'composer', 'answer')).toBe('explainer')
    expect(agentForFollowUp('what did you change?', 'composer')).toBe('explainer')
    expect(agentForFollowUp('Which files have you touched?', 'composer')).toBe('explainer')
  })

  it('never keeps a read-only agent for an edit or run request', () => {
    expect(agentForFollowUp('and run that too', 'reviewer', 'run')).toBe('composer')
    expect(agentForFollowUp('and the tests?', 'reviewer', 'edit')).toBe('composer')
    expect(agentForFollowUp('and the tests?', 'reviewer', 'review')).toBe('reviewer')
  })

  it('does not upgrade a read question after an edit turn into an edit', () => {
    expect(agentForFollowUp('Can you explain that?', 'composer', 'explore')).toBeNull()
    expect(agentForFollowUp('and the tests?', 'composer', 'answer')).toBe('composer')
  })
})
