import { describe, expect, it } from 'vitest'
import {
  formatAgentDiscussions,
  handoffFromMessages
} from '../electron/main/services/agent-discussions'

describe('agent discussions', () => {
  it('includes every other chat and skips the current thread', () => {
    const text = formatAgentDiscussions({
      currentThreadId: 'this',
      threads: [
        {
          id: 'this',
          title: 'Current',
          model: 'builtin:composer-lite',
          createdAt: 1,
          updatedAt: 2,
          messages: [{ id: '1', role: 'user', content: 'secret current', createdAt: 1 }]
        },
        {
          id: 'other',
          title: 'Review',
          model: 'builtin:composer-lite',
          createdAt: 1,
          updatedAt: 2,
          messages: [
            { id: '2', role: 'user', content: 'Review the parser', createdAt: 1 },
            {
              id: '3',
              role: 'assistant',
              content: 'The parser lives in src/parser.ts',
              agentName: 'Reviewer',
              createdAt: 2
            }
          ]
        }
      ],
      jobs: [
        {
          id: 'job',
          agentName: 'Coder',
          goal: 'Fix the parser',
          answer: 'Updated src/parser.ts',
          status: 'done',
          sourceThreadId: 'other'
        },
        {
          id: 'inbox',
          agentName: 'Composer',
          goal: 'Add logging',
          answer: 'Added logs in src/log.ts',
          status: 'done',
          sourceThreadId: null
        }
      ]
    })
    expect(text).not.toContain('secret current')
    expect(text).toContain('Reviewer: The parser lives in src/parser.ts')
    expect(text).not.toContain('Fix the parser')
    expect(text).toContain('Add logging')
    expect(text).toContain('src/log.ts')
  })

  it('hands the next turn the files the previous agent cited', () => {
    const handoff = handoffFromMessages([
      { role: 'user', content: 'What does this project do?' },
      { role: 'assistant', content: 'It calculates in src/main.ts and renders src/App.tsx.' }
    ])
    expect(handoff).toContain('src/main.ts')
    expect(handoff).toContain('src/App.tsx')
    expect(handoff).toContain('edit those files')
  })
})
