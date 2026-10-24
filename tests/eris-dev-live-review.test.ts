import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { assessDeliverable, stripProtocolTail } from '../src/shared/deliverable-checks'
import { exportCoverage } from '../src/shared/eris-dev'
import { INVARIANT_VERSION } from '../src/shared/agent-versions'
import { oneShotPrompt, replyTokenAllowance, splitSessionPrompt } from '../src/shared/llama-session'
import { INVARIANT_RULES_VERSION } from '../electron/main/services/agent/request-invariants'
import { pronounRefersToProject } from '../electron/main/services/task-resolver'
import { asksGeneralPractice, scopeApplicability } from '../electron/main/services/task-intake'
import {
  boundRuntimeInstructions,
  markUnverifiedExecutionClaims
} from '../electron/main/services/agent/compaction'
import { toolArgumentRepair } from '../electron/main/services/agent/tool-validation'
import { getToolContract } from '../electron/main/services/tool-registry'
import { captureQuestion, captureSettings } from '../electron/dev/capture'
import type { PreparedLiveModel } from '../electron/dev/models'

/*
 * Regression checks derived from docs/reviews/eris-dev-multi-2026-10-24/RECOMMENDATIONS.md.
 * Case numbers are the review's zero-based export indices.
 */

const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  vi.unstubAllGlobals()
})

const CASE_68 = `{"name":"tree","arguments":{"path":"."}}
<<<END>>>

USER:
<<<TOOL_RESULT bf8b9095:6:0>>>
TOOL_RESULT tree: NOT_EXECUTED
Directory inspection was not executed again.
<<<END_TOOL_RESULT>>>

ASSISTANT:`
const CASE_72 = `{"name":"tree","path":"."}

Then continue with retrieve/read_file on the files that answer the user, then reply in plain sentences.

ASSISTANT:`
const CASE_77 =
  'Below is a multi-step form.\n\n```csharp\nprivate void Next(object sender, EventArgs e)\n{\n    if (string.IsNullOrEmpty(name))\n    {\n'

describe('MR-001/MR-003/MR-009 deliverable checks', () => {
  it('fails protocol framing even though the transport completed (cases 68, 72)', () => {
    expect(assessDeliverable(CASE_68)).toMatchObject({ status: 'fail' })
    expect(assessDeliverable(CASE_68).checks.map((check) => check.id)).toContain('protocol-leak')
    expect(assessDeliverable(CASE_72).checks.map((check) => check.id)).toEqual(
      expect.arrayContaining(['protocol-leak', 'tool-call-as-answer'])
    )
  })

  it('separates an unfinished program from an unclosed explanatory fence', () => {
    expect(assessDeliverable(CASE_77)).toMatchObject({
      status: 'fail',
      checks: [expect.objectContaining({ id: 'unfinished-code' })]
    })
    // Case 93 stops at an opening fence with no code at all.
    expect(assessDeliverable('### Step 5\nImplement the logic.\n\n```\n').status).toBe('fail')
    expect(assessDeliverable('Run it:\n```bash\nnpm test\n')).toMatchObject({
      status: 'needs-review',
      checks: [expect.objectContaining({ id: 'unclosed-code-fence' })]
    })
  })

  it('flags refusals and clarification separately and passes an ordinary answer', () => {
    expect(assessDeliverable("I'm sorry, but I can't assist with that.").checks[0]?.id).toBe(
      'refusal'
    )
    expect(
      assessDeliverable(
        "I'm sorry, but I don't have enough context. Can you please provide more information?"
      ).checks[0]?.id
    ).toBe('clarification-request')
    expect(assessDeliverable('Use a pool:\n```python\npool = Pool(5)\n```').status).toBe('pass')
  })

  it('keeps JSON the user asked for and strips only a protocol tail', () => {
    expect(
      assessDeliverable('{"name":"read_file","path":"a.ts"}', { allowToolJson: true }).status
    ).toBe('pass')
    expect(stripProtocolTail('Use feature flags via a config service.\n\nASSISTANT:\n')).toBe(
      'Use feature flags via a config service.'
    )
    expect(stripProtocolTail(CASE_72)).toBeNull()
  })
})

describe('MR-005/MR-006 scope and pronoun resolution', () => {
  const reading = { artifact: 'plan', destination: 'chat' } as const

  it('keeps problem-anaphora generic and project-anaphora bound', () => {
    // Case 14: “it” is the problem named in the same request.
    expect(
      pronounRefersToProject(
        'I keep running into problems with per-user rate limiting. How would you solve it in Kotlin?'
      )
    ).toBe(false)
    expect(pronounRefersToProject('Could we make this easier to use?')).toBe(true)
    expect(pronounRefersToProject('How would you fix this function?')).toBe(true)
    expect(pronounRefersToProject('How would you solve it?')).toBe(true)
  })

  it('gives generic plans and practice questions the same scope with or without a project', () => {
    for (const [text, artifact, intent] of [
      [
        'I need graceful shutdown of a long-running process for an internal admin dashboard. Can you sketch the important parts?',
        'plan',
        'plan'
      ],
      [
        'How should I structure the code for scheduled report generation with Laravel?',
        'plan',
        'plan'
      ],
      [
        'How do you usually implement feature flags that can be toggled without redeploying in a Next.js application?',
        'review',
        'review'
      ],
      [
        "I'm looking for a clean way to do TOTP-based two-factor authentication using Express and TypeScript?",
        'review',
        'review'
      ]
    ] as const) {
      const withProject = scopeApplicability(
        text,
        { artifact, destination: 'chat' },
        false,
        true,
        intent
      )
      const without = scopeApplicability(
        text,
        { artifact, destination: 'chat' },
        false,
        false,
        intent
      )
      expect(withProject.applicability, text).toBe('generic')
      expect(without.applicability, text).toBe('generic')
    }
  })

  it('keeps a reference to the current implementation bound to the project (case 39)', () => {
    expect(
      scopeApplicability(
        'We need to improve our current optimistic updates for a list of items implementation. Where should we start?',
        reading,
        false,
        true,
        'plan'
      ).applicability
    ).toBe('selected-project')
    expect(asksGeneralPractice('Where is the limiter defined?')).toBe(false)
  })
})

describe('MR-010 deterministic tool repair', () => {
  const schema = getToolContract('retrieve')?.schema

  it('turns retrieve(path) on an exact file into a read_file call', () => {
    const repair = toolArgumentRepair('retrieve', { path: 'shutdown.log' }, schema, 'goal')
    expect(repair).toMatchObject({
      unknownKeys: ['path'],
      validCall: { name: 'read_file', args: { path: 'shutdown.log' } }
    })
    expect(repair.missing).toEqual(['query or pattern'])
  })

  it('builds a query from the goal only when the call supplied nothing usable', () => {
    expect(
      toolArgumentRepair('retrieve', {}, schema, 'Where is rate limiting handled?').validCall
    ).toEqual({ name: 'retrieve', args: { query: 'Where is rate limiting handled?' } })
  })
})

describe('MR-026/MR-027 truthful and bounded working memory', () => {
  it('marks execution claims that no successful action supports (case 54)', () => {
    const summary = '- Installed next-feature-flag package\n- Next: add a toggle component'
    expect(markUnverifiedExecutionClaims(summary, ['Failed run: blocked'])).toContain(
      'Installed next-feature-flag package [unverified'
    )
    expect(
      markUnverifiedExecutionClaims(summary, ['added next-feature-flag@1.0.0 (npm install)'])
    ).toBe(summary)
  })

  it('keeps the canonical system prompt and only the latest runtime instructions', () => {
    const messages = [
      { role: 'system' as const, content: 'contract' },
      { role: 'user' as const, content: 'goal' },
      ...Array.from({ length: 6 }, (_, index) => ({
        role: 'system' as const,
        content: `[Eris recovery] attempt ${index}`
      }))
    ]
    expect(boundRuntimeInstructions(messages)).toBe(true)
    expect(messages.map((message) => message.content)).toEqual([
      'contract',
      'goal',
      '[Eris recovery] attempt 4',
      '[Eris recovery] attempt 5'
    ])
  })
})

describe('MR-004/MR-013 native transport parity', () => {
  it('builds one-shot requests from the same structured history as a session turn', () => {
    const messages = [
      { role: 'system' as const, content: 'rules' },
      { role: 'user' as const, content: 'first' },
      { role: 'assistant' as const, content: 'reply' },
      { role: 'user' as const, content: 'Quote: "USER: hi ASSISTANT: there"' }
    ]
    const split = splitSessionPrompt(messages)!
    expect(oneShotPrompt(messages)).toEqual({ history: split.seed, userMessage: split.userMessage })
    // Role labels inside user data stay data; no synthetic transcript is added.
    expect(oneShotPrompt(messages).userMessage).toBe(messages[3]!.content)
  })

  it('never reserves more reply tokens than the effective context has left', () => {
    expect(replyTokenAllowance({ requested: 16384, contextSize: 8192, promptTokens: 3000 })).toBe(
      8192 - 3000 - 64
    )
    expect(replyTokenAllowance({ requested: 1024, contextSize: 32768, promptTokens: 100 })).toBe(
      1024
    )
  })
})

describe('MR-029/MR-030 provenance and export coverage', () => {
  it('has one invariant version source', () => {
    expect(INVARIANT_RULES_VERSION).toBe(INVARIANT_VERSION)
  })

  it('states a 132-of-10,000 export as partial coverage', () => {
    expect(
      exportCoverage({
        indices: Array.from({ length: 132 }, (_, index) => index),
        completed: 132,
        corpusTotal: 10000,
        runState: 'stopped',
        selection: false,
        models: ['builtin:composer-lite', 'builtin:composer-lite']
      })
    ).toEqual({
      scope: 'partial',
      runState: 'stopped',
      corpusTotal: 10000,
      completedCount: 132,
      pendingCount: 9868,
      exportedCount: 132,
      exportedIndexRanges: [[0, 131]],
      exportedPercent: 1.32,
      models: ['builtin:composer-lite']
    })
  })
})

describe('MR-002/MR-007/MR-009/MR-012 live capture', () => {
  const liveModel = (): PreparedLiveModel => {
    const settings = structuredClone(captureSettings(8192))
    settings.models.defaultModel = 'test-selected-model'
    settings.models.connections = [
      {
        id: 'fixture',
        name: 'Test provider',
        type: 'openai-compatible',
        provider: 'custom',
        enabled: true,
        baseUrl: 'http://fixture.invalid/v1',
        apiKeyRef: 'fixture-key',
        models: ['test-selected-model']
      }
    ]
    settings.agent.routing.preferCloudComposer = false
    settings.agent.routing.useLlmRouter = false
    settings.agent.routing.profile = 'local'
    return {
      settings,
      model: 'test-selected-model',
      getSecret: () => 'private-fixture-key',
      digest: 'fixture'
    }
  }
  const frame = (content: string, finish: string | null = null) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] })}\n\n`
  const sse = (content: string) =>
    new Response(`${frame(content, 'stop')}data: [DONE]\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' }
    })
  const isIntent = (body: { messages: Array<{ content?: string }> }) =>
    body.messages.some((m) => m.content?.includes('Interpret the latest request'))
  const QUESTION = 'I need a practical example of connection pooling in Python?'

  it('keeps every streamed delta and records a deadline, not a generic error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        if (isIntent(body)) return sse('{"intent":"answer","confidence":0.95}')
        const encoder = new TextEncoder()
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(frame('Part one. ')))
              controller.enqueue(encoder.encode(frame('Part two.')))
              init.signal?.addEventListener('abort', () =>
                controller.error(new DOMException('Aborted', 'AbortError'))
              )
            }
          }),
          { headers: { 'Content-Type': 'text/event-stream' } }
        )
      })
    )
    const result = await captureQuestion(
      0,
      QUESTION,
      null,
      8192,
      'ask',
      new AbortController().signal,
      { live: liveModel(), timeoutMs: 400 }
    )
    expect(result.termination?.cause).toBe('deadline-exceeded')
    expect(result.completion?.status).toBe('failed')
    expect(result.inference?.error).toBe('Live question exceeded its configured deadline.')
    // Before the fix only the last fragment survived.
    expect(result.response).toBe('Part one. Part two.')
  })

  it('answers again from the goal when the model returns protocol framing (case 72)', async () => {
    let answers = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        if (isIntent(body)) return sse('{"intent":"answer","confidence":0.95}')
        answers++
        return sse(answers === 1 ? CASE_72 : 'Use a pool:\n```python\npool = Pool(5)\n```')
      })
    )
    const result = await captureQuestion(
      0,
      QUESTION,
      null,
      8192,
      'ask',
      new AbortController().signal,
      {
        live: liveModel()
      }
    )
    expect(result.completion?.status).toBe('completed')
    expect(result.response).toContain('pool = Pool(5)')
    expect(result.response).not.toMatch(/ASSISTANT:|"name":"tree"/)
    expect(result.deliverable?.status).toBe('pass')
    expect(result.requests[result.requests.length - 1]?.termination).toMatchObject({
      reason: 'eos',
      raw: 'stop'
    })
  })

  it('continues an answer that stopped mid-code once (case 77)', async () => {
    let answers = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        if (isIntent(body)) return sse('{"intent":"answer","confidence":0.95}')
        answers++
        return sse(answers === 1 ? CASE_77 : '        return;\n    }\n}\n```')
      })
    )
    const result = await captureQuestion(
      0,
      QUESTION,
      null,
      8192,
      'ask',
      new AbortController().signal,
      {
        live: liveModel()
      }
    )
    expect(answers).toBe(2)
    expect(result.completion?.status).toBe('completed')
    expect(result.deliverable?.status).toBe('pass')
    expect(result.response).toContain('return;')
  })

  it('stops a repeated invalid retrieve before the step budget and keeps repairs machine-readable (case 37)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eris-dev-review-'))
    roots.push(root)
    writeFileSync(join(root, 'index.js'), 'export const divide = (a, b) => a / b\n')
    writeFileSync(join(root, 'package.json'), '{"name":"fixture"}')
    let agentCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        if (isIntent(body)) return sse('{"intent":"review","confidence":0.95}')
        agentCalls++
        return sse('{"name":"retrieve","path":"shutdown.log"}')
      })
    )
    const live = liveModel()
    live.settings.agent.maxStepsPerRun = 30
    const result = await captureQuestion(
      0,
      'Review the shutdown handling in this project and recommend improvements.',
      root,
      8192,
      'agent',
      new AbortController().signal,
      { live, maxCalls: 40 }
    )
    expect(agentCalls).toBeLessThanOrEqual(12)
    expect(result.termination?.cause).not.toBe('call-limit')
    const prompts = JSON.stringify(result.requests.map((request) => request.messages))
    expect(prompts).toContain('REPAIR:')
    expect(prompts).toContain('\\"validCall\\":{\\"name\\":\\"read_file\\"')
    expect(result.response ?? '').not.toMatch(/"name":"retrieve"/)
  })
})
