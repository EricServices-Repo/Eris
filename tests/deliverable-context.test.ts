import { describe, it, expect, vi } from 'vitest'
import {
  assessDeliverable,
  deliverableContext,
  stripProtocolTail
} from '../src/shared/deliverable-checks'
import { assembledSyntax } from '../electron/main/services/agent/artifact-syntax'
import { finalizeAnswer } from '../electron/main/services/agent/final-answer'
import { selectOutcomeEvidence } from '../electron/main/services/outcome-evidence'
import { createTaskContract } from '../electron/main/services/task-intake'
import { getDefaults } from '../electron/main/services/settings'
import type { TurnPlan } from '../src/shared/settings-schema'
const plan: TurnPlan = {
  intent: 'review',
  agentId: 'reviewer',
  agentName: 'Reviewer',
  mode: 'agent',
  models: { chat: 'test', tools: 'test' },
  toolPolicy: 'read',
  requiresTools: true,
  escalateToFull: false,
  reason: 'fixture',
  method: 'heuristic'
}
const task = () => {
  const task = createTaskContract({ workspacePath: null, text: 'Review alpha and omega', plan })
  task.interpretation!.obligations = [
    { id: 'alpha', kind: 'answer', text: 'Explain alpha behavior' },
    { id: 'omega', kind: 'answer', text: 'Explain omega behavior' }
  ]
  return task
}
describe('task-aware deliverable boundaries', () => {
  it('keeps intentionally quoted tool JSON and protocol examples', () => {
    const goal = 'Explain the Eris tool protocol with JSON examples',
      text =
        'Example:\n```json\n{"name":"read_file","path":"example.ts"}\n```\n\n```text\nUSER:\n<<<TOOL_RESULT example>>>\nNOT_EXECUTED\n```'
    expect(assessDeliverable(text, deliverableContext(goal)).status).toBe('pass')
    expect(stripProtocolTail(text)).toBe(text)
    expect(assessDeliverable(text).status).toBe('needs-review')
  })
  it('still fails exposed internal results even when protocol was the topic', () => {
    expect(
      assessDeliverable(
        'A useful explanation.\n<<<TOOL_RESULT internal>>>\nTOOL_RESULT read_file: NOT_EXECUTED',
        deliverableContext('Explain the tool protocol')
      ).status
    ).toBe('fail')
    expect(stripProtocolTail('Explanation\n<<<TOOL_RESULT internal>>>')).toBe('Explanation')
  })
  it('accepts the inline language-fence form supported by the renderer without a needless continuation', () => {
    expect(
      assessDeliverable('Here is the requested answer. ```typescript\nconst example = true;\n```')
        .status
    ).toBe('pass')
  })
  it('does not interpret delimiters inside strings or comments as unfinished code', () => {
    const answer = '```javascript\nconst text = "{"; // (( [[ {{\nconsole.log(text)\n'
    expect(assessDeliverable(answer).checks.map((c) => c.id)).toEqual(['unclosed-code-fence'])
    expect(assessDeliverable('```js\nfunction f() {\n').status).toBe('needs-review')
    expect(
      assessDeliverable('```js\nfunction f() {\n', { termination: 'output-limit' }).status
    ).toBe('fail')
  })
  it('parses only supported assembled artifacts and does not call syntax semantic correctness', () => {
    expect(
      assembledSyntax('```js\nconst s="{"\n```', 'Show a runnable JavaScript program')
    ).toMatchObject({ state: 'valid' })
    expect(
      assembledSyntax('```ts\nfunction broken( {\n```', 'Show a complete TypeScript program').state
    ).toBe('invalid')
    expect(assembledSyntax('```python\nif x:\n```', 'Show a complete Python program').state).toBe(
      'unavailable'
    )
    expect(assembledSyntax('```ts\nfunction fragment(\n```', 'Explain this fragment').state).toBe(
      'unavailable'
    )
  })
  it('preserves the raw draft and audit digests when stripping a genuine leak', async () => {
    const raw = 'Use a bounded queue.\n<<<TOOL_RESULT internal>>>private runtime',
      audit = vi.fn()
    const result = await finalizeAnswer(raw, {
      settings: getDefaults(),
      model: 'test',
      temperature: 0,
      getSecret: () => null,
      goal: 'Explain a queue',
      messages: [],
      onPresentation: audit
    })
    expect(result.text).toBe('Use a bounded queue.')
    expect(result.rawOutput).toBe(raw)
    expect(audit.mock.calls[0][0]).toMatchObject({ raw, repairs: ['protocol-tail-removed'] })
    expect(audit.mock.calls[0][0].rawDigest).not.toBe(audit.mock.calls[0][0].presentationDigest)
  })
  it('selects per-obligation source references including the answer tail with explicit omitted coverage', () => {
    const answer = 'alpha is first. ' + 'unrelated '.repeat(3000) + ' omega is last.'
    const selected = selectOutcomeEvidence(task(), answer, ['alpha source', 'omega source'], 1400)
    expect(selected.truncated).toBe(true)
    expect(selected.selectedChars).toBeLessThanOrEqual(1400)
    expect(selected.obligations.every((o) => o.refs.length)).toBe(true)
    expect(selected.excerpts.some((e) => e.text.includes('omega is last'))).toBe(true)
    for (const e of selected.excerpts)
      if (e.source === 'answer') expect(e.text).toBe(answer.slice(e.start, e.end))
    expect(selectOutcomeEvidence(task(), answer, [], 0).obligations.every((o) => o.omitted)).toBe(
      true
    )
  })
})
