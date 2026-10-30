import { describe, expect, it, vi } from 'vitest'
import {
  cancelAllPendingQuestions,
  requestUserQuestion,
  resolveUserQuestion,
  USER_QUESTION_TIMEOUT_MS
} from '../electron/main/services/user-question'
import {
  isReviewOnlyGoal,
  looksLikeAsksForWorkspaceInfo,
  looksLikeClarifyingQuestion,
  looksLikeTaskComplete,
  projectDescriptionReady,
  rejectedReplyReason,
  looksLikeDegenerateLoop,
  shouldKeepWorking
} from '../electron/main/services/agent/heuristics'

function fakeSender() {
  const sent: Array<{ channel: string; payload: Record<string, unknown> }> = []
  return {
    sent,
    sender: {
      isDestroyed: () => false,
      send: (channel: string, payload: Record<string, unknown>) => {
        sent.push({ channel, payload })
      }
    }
  }
}

describe('requestUserQuestion', () => {
  it('resolves with a reply', async () => {
    const { sender, sent } = fakeSender()
    const p = requestUserQuestion(sender as never, 'req-1', 'Use TypeScript?')
    const req = sent.find((s) => s.channel === 'chat:question-request')
    expect(req?.payload.question).toBe('Use TypeScript?')
    expect(req?.payload.timeoutMs).toBe(USER_QUESTION_TIMEOUT_MS)
    const id = String(req?.payload.questionId)
    expect(resolveUserQuestion(id, 'yes')).toBe(true)
    await expect(p).resolves.toEqual({ kind: 'reply', text: 'yes' })
  })

  it('times out and proceeds without a reply', async () => {
    vi.useFakeTimers()
    const { sender } = fakeSender()
    const p = requestUserQuestion(sender as never, 'req-1', 'Pick A or B?', {
      timeoutMs: 15_000
    })
    vi.advanceTimersByTime(15_000)
    await expect(p).resolves.toEqual({ kind: 'timeout' })
    vi.useRealTimers()
  })

  it('skip (null reply) proceeds like timeout', async () => {
    const { sender, sent } = fakeSender()
    const p = requestUserQuestion(sender as never, 'req-1', 'Continue?')
    const id = String(sent[0]?.payload.questionId)
    resolveUserQuestion(id, null)
    await expect(p).resolves.toEqual({ kind: 'timeout' })
  })

  it('cancel dismisses pending questions', async () => {
    const { sender } = fakeSender()
    const p = requestUserQuestion(sender as never, 'req-1', 'Still there?')
    cancelAllPendingQuestions('req-1')
    await expect(p).resolves.toEqual({ kind: 'dismissed' })
  })
})

describe('looksLikeClarifyingQuestion', () => {
  it('detects a blocking choice question', () => {
    expect(
      looksLikeClarifyingQuestion('Should I use React or Vue for this UI before I continue?')
    ).toBe(true)
  })

  it('ignores finished summaries', () => {
    expect(looksLikeClarifyingQuestion('Done. Summary: added the login form and tests.')).toBe(
      false
    )
  })

  it('does not treat workspace-info asks as clarifying questions', () => {
    const bad =
      "Sure, I'll review the project folder. Could you please provide the structure of the project folder and any relevant files so I can understand the current state of the calculator app?"
    expect(looksLikeAsksForWorkspaceInfo(bad)).toBe(true)
    expect(looksLikeClarifyingQuestion(bad)).toBe(false)
    expect(looksLikeTaskComplete(bad)).toBe(false)
    expect(
      shouldKeepWorking({
        needsTools: true,
        mutated: false,
        assistantText: bad,
        reviewOnly: true,
        inspectRounds: 0
      })
    ).toBe(true)
  })
})

describe('project description', () => {
  const description =
    'This workspace is a small calculator. src/main.ts adds and subtracts numbers from the keypad in src/App.tsx, and package.json starts it with npm start. The display lives in src/Display.tsx.'

  it('is not a defect review', () => {
    expect(isReviewOnlyGoal('Review this project, what does it do?')).toBe(false)
    expect(isReviewOnlyGoal('code review this PR')).toBe(true)
    expect(isReviewOnlyGoal('review the airbnb website, what 3 improvements should we make?')).toBe(
      true
    )
    expect(isReviewOnlyGoal('review the project folder, make improvements to the calculator')).toBe(
      false
    )
  })

  it('finishes only after a sourced description', () => {
    expect(projectDescriptionReady(description, ['Inspected .', 'Read .eris/agents.json'])).toBe(
      false
    )
    expect(projectDescriptionReady(description, ['Read package.json', 'Read src/main.ts'])).toBe(
      true
    )
    expect(
      shouldKeepWorking({
        needsTools: true,
        mutated: false,
        assistantText: 'Finished.',
        describeProject: true,
        actions: ['Read package.json']
      })
    ).toBe(true)
    expect(
      shouldKeepWorking({
        needsTools: true,
        mutated: false,
        assistantText: description,
        describeProject: true,
        actions: ['Read package.json']
      })
    ).toBe(false)
  })

  it('stops a read-only chat once the reply explains a file it read', () => {
    const note =
      'The calculator adds numbers in src/main.ts and shows them from src/App.tsx. package.json starts it with npm start.'
    expect(
      shouldKeepWorking({
        needsTools: true,
        mutated: false,
        assistantText: note,
        chatReply: true,
        actions: ['Read src/main.ts'],
        inspectRounds: 1
      })
    ).toBe(false)
    expect(
      shouldKeepWorking({
        needsTools: true,
        mutated: false,
        assistantText: '{"name":"write_file","path":"App.js","content":"x"}',
        chatReply: true,
        actions: ['Read README.md']
      })
    ).toBe(true)
  })
})

describe('repeat loop detection', () => {
  const item = (n: number, name: string) =>
    [
      `### ${n}. **${name}**`,
      '**Path:** `public/js/main.js`',
      `**Issue:** ${name} is missing from the site.`,
      '',
      '```javascript',
      `function ${name}() {`,
      '  if (ready) {',
      '    return true',
      '  }',
      '}',
      '```',
      '',
      '---'
    ].join('\n')
  it('leaves a long structured list alone', () => {
    const names = ['search', 'pagination', 'caching', 'validation', 'logging', 'alerts', 'tests']
    const list = names.map((name, index) => item(index + 1, name)).join('\n')
    for (let end = 1; end <= list.length; end++)
      expect(looksLikeDegenerateLoop(list.slice(0, end))).toBe(false)
  })
  it('leaves repeated markup in a code block alone', () => {
    const page = Array.from({ length: 12 }, (_, n) => `<p>row ${n}</p>\n</div>`).join('\n')
    expect(looksLikeDegenerateLoop(`\`\`\`html\n${page}\n\`\`\``)).toBe(false)
  })
  it('still stops a repeated sentence', () => {
    const line = 'The same finding repeats here forever and ever.'
    expect(looksLikeDegenerateLoop(Array.from({ length: 12 }, () => line).join('\n'))).toBe(true)
  })
  it('still stops repeated code', () => {
    const line = 'console.log("the same statement again and again");'
    expect(looksLikeDegenerateLoop(`\`\`\`js\n${Array(12).fill(line).join('\n')}`)).toBe(true)
  })
})

describe('rejected reply reasons', () => {
  it('names why a reply was rejected without repeating it', () => {
    const prose = 'The project could use better error handling and more tests overall.'
    expect(rejectedReplyReason(prose, [])).toBe('no-source-evidence')
    expect(rejectedReplyReason(prose, ['Read src/retry.ts'])).toBe('not-complete')
    expect(rejectedReplyReason(prose, ['Read .eris/notes.md'])).toBe('no-source-evidence')
    expect(rejectedReplyReason('   ', [])).toBe('tool-text-only')
    const list = [1, 2, 3, 4, 5].map((n) => `${n}. Add test coverage for module ${n}`).join('\n')
    expect(rejectedReplyReason(list, [])).toBe('no-source-evidence')
  })
})
