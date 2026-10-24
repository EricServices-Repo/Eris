import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { parseQuestions } from '../electron/dev/questions'
import { captureQuestion } from '../electron/dev/capture'
const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  vi.unstubAllGlobals()
})
describe('Eris-Dev question import', () => {
  it('preserves multiline JSON questions and accepts BOM, CRLF and JSONL', () => {
    expect(parseQuestions('\uFEFFfirst\r\n\r\nsecond', '.txt')).toEqual(['first', 'second'])
    expect(
      parseQuestions('[{"question":"Review code\\nRecommend improvements"}]', '.json')
    ).toEqual(['Review code\nRecommend improvements'])
    expect(parseQuestions('"first"\n{"text":"second"}', '.jsonl')).toEqual(['first', 'second'])
  })
  it('rejects invalid records and oversized batches rather than silently dropping them', () => {
    expect(() => parseQuestions('["valid",{}]', '.json')).toThrow('Question 2')
    expect(() => parseQuestions(Array(10001).fill('question').join('\n'), '.txt')).toThrow('10,000')
    expect(() => parseQuestions('', '.txt')).toThrow()
  })
})
describe('production agent request capture', () => {
  it.each([
    'Review the website build\nRecommend 5 improvements',
    'Fix division by zero in index.js'
  ])('captures %s without provider calls or source changes', async (question) => {
    const root = mkdtempSync(join(tmpdir(), 'eris-dev-capture-'))
    roots.push(root)
    const source = 'export function divide(a, b) { return a / b }\n'
    writeFileSync(join(root, 'index.js'), source)
    writeFileSync(join(root, 'package.json'), '{"name":"test-app"}')
    const fetch = vi.fn(() => {
      throw new Error('Unexpected provider/network call')
    })
    vi.stubGlobal('fetch', fetch)
    const result = await captureQuestion(
      0,
      question,
      root,
      8192,
      'agent',
      new AbortController().signal
    )
    expect(result.status, result.detail).toBe('captured')
    expect(result.requests.some((request) => request.purpose === 'agent')).toBe(true)
    expect(JSON.stringify(result.requests)).toContain(question.replaceAll('\n', '\\n'))
    expect(result.task).toBeDefined()
    expect(readFileSync(join(root, 'index.js'), 'utf8')).toBe(source)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('honors cancellation before processing a question', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eris-dev-cancel-'))
    roots.push(root)
    const controller = new AbortController()
    controller.abort()
    const result = await captureQuestion(
      0,
      'Review the code',
      root,
      8192,
      'agent',
      controller.signal
    )
    expect(result.status).toBe('cancelled')
    expect(result.requests).toHaveLength(0)
  })
})

import { prepareQuestions } from '../electron/dev/questions'
import { snapshotPolicy } from '../electron/dev/snapshot'
import { readCaptureRecord } from '../src/shared/eris-dev'

const sampleWorkspace = () => {
  const root = mkdtempSync(join(tmpdir(), 'eris-dev-sample-'))
  roots.push(root)
  writeFileSync(join(root, 'index.js'), 'export function divide(a, b) { return a / b }\n')
  writeFileSync(join(root, 'package.json'), '{"name":"debug-fixture"}')
  return root
}
const capture = (
  question: string,
  workspace: string | null,
  options: Parameters<typeof captureQuestion>[6] = {}
) => captureQuestion(0, question, workspace, 8192, 'agent', new AbortController().signal, options)

describe('AG-065/AG-066 import preview and stable question IDs', () => {
  it('normalizes a numbered file with headings to exactly its questions', () => {
    const questions = Array.from({ length: 10000 }, (_, i) => `${i + 1}. How do I test case ${i}?`)
    const preview = prepareQuestions(
      ['10,000 natural diverse coding questions', 'Generated for Eris', '', ...questions].join(
        '\n'
      ),
      '.txt',
      'corpus.txt'
    )
    expect(preview.questions).toHaveLength(10000)
    expect(preview.questions[0]).toMatchObject({ text: 'How do I test case 0?', sourceLine: 4 })
    expect(preview.excluded.map((line) => line.sourceLine)).toEqual([1, 2])
    expect(preview.normalization.join(' ')).toMatch(/Removed leading question numbers/)
  })

  it('excludes leading headings from an unnumbered question list', () => {
    const preview = prepareQuestions(
      'Coding questions:\nHow do I cache?\nWhat is a closure?',
      '.txt'
    )
    expect(preview.questions.map((q) => q.text)).toEqual(['How do I cache?', 'What is a closure?'])
    expect(preview.excluded).toEqual([
      { sourceLine: 1, text: 'Coding questions:', reason: 'heading before the first question' }
    ])
  })

  it('keeps IDs stable across reordering and distinct for duplicates', () => {
    const a = prepareQuestions('First?\nSecond?\nFirst?', '.txt').questions
    const b = prepareQuestions('Second?\nFirst?', '.txt').questions
    expect(a[0]!.id).toBe(b[1]!.id)
    expect(a[1]!.id).toBe(b[0]!.id)
    expect(a[2]!.id).not.toBe(a[0]!.id)
    expect(a[2]).toMatchObject({ occurrence: 2, sourceLine: 3 })
  })

  it('carries per-question scripted intent replies from JSONL', () => {
    const [question] = prepareQuestions(
      '{"question":"Tidy utils?","intentReply":{"intent":"review","confidence":0.9}}',
      '.jsonl'
    ).questions
    expect(question?.intentReply).toEqual({ intent: 'review', confidence: 0.9 })
  })
})

describe('AG-061 versioned records', () => {
  it('reads a v1 record without implying a model response', () => {
    const record = readCaptureRecord({
      index: 2812,
      question: 'Q2813',
      status: 'captured',
      calls: 2,
      detail: 'Stopped at the model transport boundary. No agent response was generated.',
      requests: [],
      events: [],
      durationMs: 1
    })
    expect(record).toMatchObject({
      response: null,
      responseReason: 'not-observed-v1',
      sourceLine: 2813,
      stages: { reachability: 'captured', inference: 'not-run', answerQuality: 'not-evaluated' }
    })
  })
})

describe('AG-062/AG-068 capture release gate', () => {
  // Review-named questions: each must reach the boundary with no request-level defect.
  it.each([
    'Can you generate a minimal but complete example of soft deletes with the ability to restore in TypeScript?',
    'Can you write per-user rate limiting so the happy path is obvious and errors are explicit?',
    'Can you write a clear Java version of generating image thumbnails on the fly?',
    'Write a TypeScript implementation of cache invalidation after data changes that prioritizes clarity?',
    'I want request validation middleware to be easy to reason about. How would you write it?',
    'Show me an example of health checks that verify downstream dependencies inside a Django project?',
    'Write a TypeScript implementation of seeding realistic test data that prioritizes clarity?',
    'How would you design the data model and API for infinite scroll using cursor pagination?',
    'How would you design the data model and API for transactional emails using templates?',
    'How would you design the data model and API for role-based access control?',
    'Fix division by zero in index.js'
  ])('%s', async (question) => {
    const result = await capture(question, sampleWorkspace())
    expect(result.status, result.detail).toBe('captured')
    expect(result.findingsDetail.filter((finding) => finding.severity === 'defect')).toEqual([])
    expect(result.stages).toMatchObject({ inference: 'not-run', answerQuality: 'not-evaluated' })
    expect(result.response).toBeNull()
    expect(result.intent).not.toBe('capability')
    expect(result.intent).not.toBe('verify')
    // AG-047: each agent request carries its context manifest.
    const agent = result.requests.filter((request) => request.purpose === 'agent')
    expect(agent.length).toBeGreaterThan(0)
    for (const request of agent) expect(request.context).toBeDefined()
  })

  it('records labeled timings and a factual resolver event', async () => {
    const result = await capture(
      'Can you generate a minimal but complete example of soft deletes with the ability to restore in TypeScript?',
      sampleWorkspace()
    )
    expect(result.timing).toBe('pre-inference')
    expect(Object.keys(result.phases)).toEqual(['routeMs', 'resolveMs', 'promptMs', 'toBoundaryMs'])
    expect(result.events.join('\n')).toContain('fallback:edit-to-code-example-answer')
    expect(result.events.join('\n')).not.toMatch(/retain deterministic routing/)
    expect(result.routeDecision).toBeDefined()
  })
})

describe('AG-045 workspace-independent captures', () => {
  it('captures a generic example with no project and keeps its reading', async () => {
    const question = 'Can you write a clear Java version of generating image thumbnails on the fly?'
    const none = await capture(question, null)
    const sample = await capture(question, sampleWorkspace())
    expect(none.status, none.detail).toBe('captured')
    const reading = (result: typeof none) => {
      const task = result.task as {
        authority: unknown
        scope: { applicability?: string }
        interpretation: { artifact: string; language: string }
      }
      return {
        authority: task.authority,
        applicability: task.scope.applicability,
        artifact: task.interpretation.artifact,
        language: task.interpretation.language
      }
    }
    expect(reading(none)).toEqual(reading(sample))
    expect(reading(none).applicability).toBe('generic')
  })

  it('answers a generic explanation without forcing workspace tools or retrieval', async () => {
    const result = await capture('Explain how JWT refresh tokens work', sampleWorkspace())
    expect(result.intent).toBe('explore')
    expect(result.requests.find((r) => r.purpose === 'agent')?.tools).toEqual([])
    expect(result.retrieval).toBeUndefined()
  })
})

describe('AG-019 intent reply modes', () => {
  const question = 'Could we make this easier to use?'
  const failure = (result: Awaited<ReturnType<typeof capture>>) =>
    (result.routeDecision as { resolution: { failure?: string; source: string } }).resolution

  it.each([
    ['fallback', 'low-confidence'],
    ['malformed', 'malformed-json'],
    ['timeout', 'timeout']
  ] as const)('labels %s replies as %s', async (mode, expected) => {
    const result = await capture(question, sampleWorkspace(), { intentReplyMode: mode })
    expect(result.intentReplySource).toBe(mode)
    expect(failure(result)).toMatchObject({ source: 'fallback', failure: expected })
  })

  it('uses a scripted reply supplied by the corpus and says so', async () => {
    const result = await capture(question, sampleWorkspace(), {
      question: { intentReply: { intent: 'review', confidence: 0.95 } }
    })
    expect(result.intentReplySource).toBe('question-script')
    expect(failure(result)).toMatchObject({ source: 'semantic' })
    expect(result.intent).toBe('review')
  })
})

describe('AG-046 snapshot policy', () => {
  it.each([
    ['.eris/rules.md', false, null],
    ['.github/workflows/ci.yml', false, null],
    ['.env', false, 'possible secret'],
    ['config/.env.production', false, 'possible secret'],
    ['keys/server.pem', false, 'possible secret'],
    ['node_modules', true, 'dependencies or build output'],
    ['.git', true, 'version control data'],
    ['.eris/checkpoints', true, 'Eris workspace state'],
    ['.idea', true, 'hidden entry'],
    ['src/index.ts', false, null]
  ] as const)('%s → %s', (path, directory, expected) => {
    expect(snapshotPolicy(path, directory, false)).toBe(expected)
  })
})

describe('AG-052 conversation captures', () => {
  const review = [
    { role: 'user' as const, content: 'Review index.js and recommend improvements.' },
    {
      role: 'assistant' as const,
      content:
        'Recommendations:\n- Guard divide in index.js against a zero divisor.\n- Add a test for divide.'
    }
  ]

  it('imports history and keys the question ID to it', () => {
    const [plain] = prepareQuestions('{"question":"Implement those"}', '.jsonl').questions
    const [followUp] = prepareQuestions(
      JSON.stringify({ question: 'Implement those', history: review }),
      '.jsonl'
    ).questions
    expect(followUp?.history).toEqual(review)
    expect(followUp?.id).not.toBe(plain?.id)
    expect(() =>
      prepareQuestions('{"question":"x","history":[{"role":"system","content":"y"}]}', '.jsonl')
    ).toThrow(/user or assistant role/)
  })

  it('captures a follow-up with the referenced recommendations', async () => {
    const result = await capture('Implement those recommendations.', sampleWorkspace(), {
      question: { history: review }
    })
    expect(result.status, result.detail).toBe('captured')
    expect(result.intent).toBe('edit')
    const task = result.task as { recommendations: Array<{ targets?: string[] }> }
    expect(task.recommendations).toHaveLength(2)
    expect(task.recommendations[0]?.targets).toEqual(['index.js'])
    expect(result.findingsDetail.filter((finding) => finding.severity === 'defect')).toEqual([])
  })
})

import { questionBatches } from '../electron/dev/batches'
import { captureSettings } from '../electron/dev/capture'
import type { PreparedLiveModel } from '../electron/dev/models'

describe('Eris-Dev live model runs', () => {
  const liveModel = (): PreparedLiveModel => {
    // structuredClone deliberately drops the capture-only symbol: this is a live transport fixture.
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
  const sse = (content: string) =>
    new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
  it('chunks into ten sequential cases and preserves the correct boundary on resume', async () => {
    const batches = []
    for await (const batch of questionBatches(23, 7, new AbortController().signal))
      batches.push(batch)
    expect(batches.map((b) => b.indices)).toEqual([
      [7, 8, 9],
      [10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
      [20, 21, 22]
    ])
    const controller = new AbortController()
    const iterator = questionBatches(23, 0, controller.signal)
    expect((await iterator.next()).value?.number).toBe(1)
    controller.abort()
    expect((await iterator.next()).done).toBe(true)
  })
  it('runs production intent and answer transports with the selected model and saves the actual answer', async () => {
    const bodies: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        bodies.push(body)
        return sse(
          body.messages.some((m: { content: string }) =>
            m.content.includes('Interpret the latest request')
          )
            ? '{"intent":"answer","confidence":0.95}'
            : '```python\nprint("hello")\n```'
        )
      })
    )
    const result = await captureQuestion(
      0,
      'I need a practical example of connection pooling in Python?',
      null,
      8192,
      'ask',
      new AbortController().signal,
      { live: liveModel() }
    )
    expect(result.stages.inference, result.detail).toBe('completed')
    expect(result.response).toContain('print("hello")')
    expect(result.sourceMode).toBe('live')
    expect(result.responseReason).toBe('generated')
    expect(result.intentReplySource).toBe('live')
    expect(result.inference?.calls).toBeGreaterThanOrEqual(2)
    expect(bodies.every((b) => b.model === 'test-selected-model')).toBe(true)
    expect(result.requests.every((r) => r.model === 'test-selected-model')).toBe(true)
    expect(JSON.stringify(result)).not.toContain('private-fixture-key')
    expect(result.stages.answerQuality).toBe('not-evaluated')
  })
  it('continues the real agent loop through a native read tool and saves its final answer', async () => {
    const root = sampleWorkspace()
    let sawSource = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        if (
          body.messages.some((m: { content?: string }) =>
            m.content?.includes('Interpret the latest request')
          )
        )
          return sse('{"intent":"review","confidence":0.95}')
        const toolResult = body.messages.find((m: { role: string }) => m.role === 'tool')
        if (toolResult) {
          sawSource = JSON.stringify(toolResult).includes('return a / b')
          return sse('The divide function has no zero-divisor guard.')
        }
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"index.js"}' } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`
        )
      })
    )
    const result = await captureQuestion(
      0,
      'Review the function in index.js for bugs.',
      root,
      8192,
      'agent',
      new AbortController().signal,
      { live: liveModel() }
    )
    expect(result.stages.inference, result.detail).toBe('completed')
    expect(sawSource).toBe(true)
    expect(result.response).toContain('zero-divisor')
    expect(readFileSync(join(root, 'index.js'), 'utf8')).toContain('return a / b')
    expect(result.requests.filter((r) => r.purpose === 'agent').length).toBeGreaterThanOrEqual(2)
  })

  it.each([
    [
      "I'm trying to add database connection pooling for an internal admin dashboard. What's the best way?",
      'review',
      'design'
    ],
    [
      'Can you generate a minimal but complete example of soft deletes with the ability to restore in TypeScript?',
      'edit',
      'code-example'
    ],
    [
      "I need to introduce user authentication with magic links into an existing Next.js project. What's the safest approach?",
      'review',
      'explanation'
    ]
  ])(
    'keeps the requested chat deliverable when a confident resolver misroutes %s',
    async (question, proposed, artifact) => {
      const root = sampleWorkspace()
      const original = readFileSync(join(root, 'index.js'), 'utf8')
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body))
          return sse(
            body.messages.some((m: { content?: string }) =>
              m.content?.includes('Interpret the latest request')
            )
              ? JSON.stringify({ intent: proposed, confidence: 0.9 })
              : 'Here is the requested answer. ```typescript\nconst example = true;\n```'
          )
        })
      )
      const result = await captureQuestion(
        0,
        question,
        root,
        8192,
        'agent',
        new AbortController().signal,
        { live: liveModel() }
      )
      expect(result.intent).toBe('answer')
      expect(result.artifact).toBe(artifact)
      expect(result.completion).toMatchObject({ status: 'completed' })
      expect(result.response).toContain('requested answer')
      expect(result.calls).toBe(2)
      expect(result.requests.filter((r) => r.purpose === 'agent')[0]?.tools).toEqual([])
      expect(readFileSync(join(root, 'index.js'), 'utf8')).toBe(original)
      expect(result.events.join(' ')).not.toMatch(/re-route|budget reached/)
    }
  )

  it('marks a step-budget stop incomplete rather than treating the summary as a finished answer', async () => {
    const live = liveModel()
    live.settings.agent.maxStepsPerRun = 10
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sse('I will fix the code after inspecting it.'))
    )
    const result = await captureQuestion(
      0,
      'Fix the division by zero bug in index.js.',
      sampleWorkspace(),
      8192,
      'agent',
      new AbortController().signal,
      { live, maxCalls: 20 }
    )
    expect(result.completion).toMatchObject({ status: 'incomplete' })
    expect(result.completion?.reason).toMatch(/incomplete|stopped/i)
    expect(result.response).toMatch(/incomplete|stopped/i)
  })

  it('records provider failures without presenting an error message as a generated answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Unavailable', { status: 503 }))
    )
    const result = await captureQuestion(
      0,
      'Explain connection pooling?',
      null,
      8192,
      'ask',
      new AbortController().signal,
      { live: liveModel() }
    )
    expect(result.stages.inference).toBe('error')
    expect(result.responseReason).toBe('inference-failed')
    expect(result.inference?.error).toContain('503')
  })
  it('cancels an in-flight live transport and preserves an interrupted attempt', async () => {
    const controller = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        controller.abort()
        throw new DOMException(init.signal?.aborted ? 'Aborted' : 'Cancelled', 'AbortError')
      })
    )
    const result = await captureQuestion(
      0,
      'Explain connection pooling?',
      null,
      8192,
      'ask',
      controller.signal,
      { live: liveModel() }
    )
    expect(result.status).toBe('cancelled')
    expect(result.stages.inference).toBe('cancelled')
    expect(result.responseReason).toBe('inference-failed')
  })
})

import { runGit } from '../electron/main/services/git-service'
import { runInDiagnosticsScope } from '../electron/main/services/model-transport'
it('blocks direct Git subprocesses in live diagnostics as well as ordinary shell commands', async () => {
  const blocked: string[] = []
  const result = await runInDiagnosticsScope(
    {
      runId: 'git-boundary',
      mode: 'real-model',
      adapter: {
        kind: 'live',
        async *stream() {
          yield ''
        }
      },
      onBlockedEffect: (kind, detail) => blocked.push(`${kind}: ${detail}`)
    },
    () => runGit(process.cwd(), ['--version'])
  )
  expect(result.code).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('disabled in diagnostics')
  expect(blocked).toEqual(['command: git --version'])
})

it('recovers incomplete outcomes in earlier live exports without treating ordinary prose as a stop signal', () => {
  const record = {
    sourceMode: 'live',
    responseReason: 'generated',
    response: 'Stopped after 10 steps.',
    events: ['Paused · run step budget reached']
  }
  expect(readCaptureRecord(record).completion?.status).toBe('incomplete')
  expect(
    readCaptureRecord({
      ...record,
      events: ['Done'],
      response: 'An incomplete transaction should roll back.'
    }).completion
  ).toBeUndefined()
})
