import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const model = vi.hoisted(() => ({
  replies: [] as string[],
  calls: [] as Array<{ messages: Array<{ role: string; content: string }> }>
}))
vi.mock('../electron/main/services/agent/stream', async (original) => ({
  ...(await original<object>()),
  collectModelText: async (options: { messages: Array<{ role: string; content: string }> }) => {
    model.calls.push(options)
    return model.replies.shift() ?? ''
  }
}))
import {
  finalizeAnswer,
  MAX_REPAIR_CALLS,
  PROTOCOL_BLOCKER,
  softenUnverifiedClaims,
  unbackedEditClaims
} from '../electron/main/services/agent/final-answer'
import { createTaskContract } from '../electron/main/services/task-intake'
import { getDefaults } from '../electron/main/services/settings'
import type { TurnPlan } from '../src/shared/settings-schema'

let workspace: string
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'eris-repair-'))
  model.calls.length = 0
  model.replies.length = 0
})
afterEach(() => rmSync(workspace, { recursive: true, force: true }))

const plan: TurnPlan = {
  intent: 'edit',
  agentId: 'composer',
  agentName: 'Composer',
  mode: 'agent',
  toolPolicy: 'edit',
  requiresTools: true,
  escalateToFull: false,
  reason: 'test',
  method: 'heuristic',
  models: { chat: 'local:test', tools: 'local:test' }
}
const goal = 'Fix the divide-by-zero bug in src/math.ts'
const leaked = '{"name":"write_file","path":"src/math.ts"}'
const audits: unknown[] = []
const finalize = (draft: string, extra: Record<string, unknown> = {}) =>
  finalizeAnswer(draft, {
    settings: getDefaults(),
    model: 'test',
    temperature: 0.2,
    getSecret: () => null,
    goal,
    task: createTaskContract({ workspacePath: workspace, text: goal, plan }),
    messages: [{ role: 'user', content: goal }],
    evidence: 'src/math.ts:\nexport const divide = (a, b) => a / b',
    onPresentation: (audit) => audits.push(audit),
    ...extra
  })

describe('bounded, grounded answer repair (#454)', () => {
  it('uses a grounded re-answer instruction for source-required work', async () => {
    model.replies.push('The divide guard in src/math.ts now throws on zero.')
    await finalize(leaked, { changedFiles: ['src/math.ts'] })
    const system = model.calls[0]!.messages.map((m) => m.content).join('\n')
    expect(system).toContain('not yet verified')
    expect(system).not.toContain('give general guidance')
    expect(system).toContain(
      'Changes actually applied (in this task or the turn it continues): src/math.ts'
    )
  })

  it('rejects a repair that claims edits the task never made', async () => {
    model.replies.push('I updated src/math.ts and also created src/math.test.ts with new tests.')
    const result = await finalize(leaked, { changedFiles: ['src/math.ts'] })
    expect(result.text).toBe(PROTOCOL_BLOCKER)
    expect(result.incomplete).toBe(true)
    expect(result.repaired).not.toContain('re-answered-from-goal')
  })

  it('rejects a pathless change claim on project work when nothing changed', async () => {
    model.replies.push('I fixed the bug by adding a zero check.')
    const result = await finalize(leaked, { changedFiles: [] })
    expect(result.incomplete).toBe(true)
  })

  it('accepts a grounded summary of the edit that actually happened', async () => {
    model.replies.push('I updated src/math.ts so divide throws when b is 0.')
    const result = await finalize(leaked, { changedFiles: ['src/math.ts'] })
    expect(result).toMatchObject({ incomplete: false, repaired: ['re-answered-from-goal'] })
  })

  it('records every repair attempt separately from the raw output', async () => {
    audits.length = 0
    model.replies.push('I created src/extra.ts.')
    await finalize(leaked, { changedFiles: [] })
    const audit = audits.at(-1) as { raw: string; attempts: Array<Record<string, unknown>> }
    expect(audit.raw).toBe(leaked)
    expect(audit.attempts).toEqual([
      expect.objectContaining({ kind: 're-answer', accepted: false, reason: expect.any(String) })
    ])
  })

  it('never spends more than the bounded number of repair calls', async () => {
    // Re-answer asks a question (evasion repair follows), which then stops mid-code
    // (a continuation would follow). Unbounded, this took three extra model calls.
    model.replies.push("I'm sorry, could you provide more context about which file to change?")
    model.replies.push('Here is the fix for src/math.ts:\n```ts\nexport const divide = (a, b) => {')
    model.replies.push('  if (b === 0) throw new Error("zero")\n}\n```')
    const result = await finalize(leaked, { changedFiles: ['src/math.ts'] })
    expect(model.calls).toHaveLength(MAX_REPAIR_CALLS)
    expect(result.incomplete).toBe(true)
  })
})

describe('follow-up about a prior turn', () => {
  it('accepts a repair that reports files the continued turn changed', async () => {
    const task = createTaskContract({
      workspacePath: workspace,
      text: 'What did you change?',
      plan
    })
    task.continuation = {
      priorTaskId: 'prior',
      changedFiles: ['src/retry.ts'],
      recommendationSource: 'none'
    }
    model.replies.push('I changed src/retry.ts so retryDelay rejects out-of-range attempts.')
    const result = await finalize(leaked, { task, changedFiles: [] })
    expect(result).toMatchObject({ incomplete: false, repaired: ['re-answered-from-goal'] })
  })
})

describe('unbackedEditClaims', () => {
  it('does not treat creative first-person prose or non-paths as edit claims', () => {
    expect(unbackedEditClaims('I wrote this poem for you, e.g. about rain.', [], false)).toEqual([])
    expect(unbackedEditClaims('I updated v1.2 of the plan.', ['a.ts'])).toEqual([])
  })
  it('matches changed files by relative path or basename', () => {
    expect(unbackedEditClaims('I modified ./src/math.ts.', ['src/math.ts'])).toEqual([])
    expect(unbackedEditClaims('I changed math.ts.', ['src/math.ts'])).toEqual([])
    expect(unbackedEditClaims('I changed src/other.ts.', ['src/math.ts'])).toEqual(['src/other.ts'])
  })
})

describe('narrated tool calls never reach the user (#506)', () => {
  const draft =
    'Fixed the divide-by-zero check in src/math.ts. Next, I will run a cat command to verify.\n\n```json\n{"name":"run","arguments":{"command":"cat src/math.ts"}}\n```'

  it('re-answers once, then strips the call and its announcing sentence', async () => {
    model.replies.push(draft)
    const result = await finalize(draft, { changedFiles: ['src/math.ts'] })
    expect(result.text).not.toMatch(/"name"\s*:\s*"run"|```/)
    expect(result.text).not.toMatch(/Next, I will run/)
    expect(result.text).toMatch(/^Fixed the divide-by-zero check/)
    expect(result.incomplete).toBe(true)
    expect(result.repaired).toContain('tool-call-removed')
  })

  it('uses a clean re-answer when the model gives one', async () => {
    model.replies.push('Fixed the divide-by-zero check in src/math.ts: divide now throws when b is 0.')
    const result = await finalize(draft, { changedFiles: ['src/math.ts'] })
    expect(result.text).toMatch(/throws when b is 0/)
    expect(result.incomplete).toBe(false)
  })
})

describe('unverified claims (#509)', () => {
  it('removes quality and verification claims and adds the note', async () => {
    const result = await finalize(
      'The hello.html file has been updated with the correct footer. I have verified that it works correctly.',
      { changedFiles: ['hello.html'], verification: 'no-check' }
    )
    expect(result.text).toBe(
      'The hello.html file has been updated with the footer.\n\nNot verified: this project has no test or typecheck script.'
    )
    expect(result.repaired).toContain('unverified-claims-softened')
  })

  it('leaves the answer alone when verification passed or nothing changed', async () => {
    const text = 'Updated src/math.ts and verified it with npm test.'
    expect((await finalize(text, { changedFiles: ['src/math.ts'], verification: 'passed' })).text).toBe(text)
    expect(softenUnverifiedClaims('Here is how to write a correct footer.')).not.toBeNull()
    expect((await finalize('Explained the footer markup.', { changedFiles: ['a.html'], verification: 'no-check' })).text).toBe('Explained the footer markup.')
  })

  it('does not add a second note when the host appends one', async () => {
    const result = await finalize('Updated hello.html with the correct footer.', {
      changedFiles: ['hello.html'], verification: 'no-check', verificationNoted: true
    })
    expect(result.text).toBe('Updated hello.html with the footer.')
  })

  it('keeps code blocks unchanged', () => {
    expect(softenUnverifiedClaims('Done.\n```js\n// verified correctly\n```')).toBeNull()
  })
})

it('removes a trailing "and verified" (#509)', () => {
  expect(softenUnverifiedClaims('Updated hello.html with the correct footer and verified.')).toBe('Updated hello.html with the footer.')
})
