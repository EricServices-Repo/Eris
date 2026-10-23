import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DevComparison, DevProgress, DevQuestion, DevResult } from '../src/shared/eris-dev'
import { readCaptureRecord } from '../src/shared/eris-dev'
import { compareCaptures, runCompatibility } from '../src/shared/eris-dev-compare'
import { migrateLegacyIdentity, prepareQuestions } from '../electron/dev/questions'
import { caseRecordProblem, resumeConflicts } from '../electron/dev/runs'
import { CaptureSanitizer } from '../electron/dev/sanitize'

/**
 * docs/reviews/eris-dev-followup-2026-10-23/FOLLOW-UP-REVIEW.md, Batch B: the
 * Eris-Dev main process through its real IPC handlers (FR-021/022/026–030), plus
 * comparison identity (FR-019/020/023), resume validation (FR-025), import
 * (FR-031/032) and export redaction (FR-033–035). Electron and the capture step
 * are replaced; the handlers, run files and comparison logic are the real ones.
 */

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, (event: unknown, ...args: unknown[]) => unknown>,
  userData: '',
  open: [] as string[][],
  save: [] as string[],
  sent: [] as DevProgress[],
  /** Called for every captured question; replace per test. */
  capture: null as
    null | ((index: number, question: DevQuestion, signal: AbortSignal) => Promise<DevResult>)
}))

vi.mock('electron', () => ({
  app: {
    setName: () => undefined,
    setPath: () => undefined,
    getPath: () => h.userData,
    getVersion: () => '0.0.0-test',
    getAppPath: () => process.cwd(),
    whenReady: () => Promise.resolve(),
    on: () => undefined
  },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      h.handlers[channel] = fn
    }
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: false, filePaths: h.open.shift() ?? [] }),
    showSaveDialog: async () => ({ canceled: false, filePath: h.save.shift() })
  },
  BrowserWindow: class {
    webContents = {
      send: (_channel: string, payload: DevProgress) => h.sent.push(payload),
      isDestroyed: () => false,
      setWindowOpenHandler: () => undefined,
      on: () => undefined
    }
    isDestroyed = () => false
    loadURL = () => undefined
    loadFile = () => undefined
  }
}))

vi.mock('../electron/dev/capture', async () => {
  const actual =
    await vi.importActual<typeof import('../electron/dev/capture')>('../electron/dev/capture')
  return {
    ...actual,
    captureQuestion: (
      index: number,
      _text: string,
      _workspace: string | null,
      _context: number,
      _mode: string,
      signal: AbortSignal,
      options: { question: DevQuestion }
    ) => h.capture!(index, options.question, signal)
  }
})

const result = (
  index: number,
  question: DevQuestion,
  overrides: Partial<DevResult> = {}
): DevResult => ({
  index,
  questionId: question.id,
  sourceLine: question.sourceLine,
  question: question.text,
  status: 'captured',
  stages: {
    reachability: 'captured',
    requestValidity: 'no-findings',
    inference: 'not-run',
    answerQuality: 'not-evaluated'
  },
  intent: 'answer',
  calls: 1,
  findings: { defect: 0, review: 0 },
  findingIds: [],
  requests: [
    {
      purpose: 'agent',
      model: 'simulated:scripted',
      messages: [{ role: 'system', content: 'contract' }],
      tools: [],
      temperature: 0
    }
  ],
  response: null,
  responseReason: 'not-generated',
  sourceMode: 'capture',
  intentReplySource: 'fallback',
  findingsDetail: [],
  events: [],
  phases: { routeMs: 0, resolveMs: 0, promptMs: 0, toBoundaryMs: 0 },
  timing: 'pre-inference',
  durationMs: 0,
  ...overrides
})

let root = ''
const priorTmp = process.env.TMPDIR
const invoke = (channel: string, ...args: unknown[]) => h.handlers[channel]!({}, ...args)
const idle = async () => {
  for (let i = 0; i < 400; i++) {
    const last = h.sent.at(-1)
    if (last && !last.running) return last
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('run did not finish')
}
const runDirs = () => readdirSync(join(h.userData, 'captures'))
const snapshots = () =>
  readdirSync(process.env.TMPDIR!).filter((name) => name.startsWith('eris-dev-'))
const questionsFile = (lines: string[]) => {
  const path = join(root, `questions-${Math.random().toString(16).slice(2)}.txt`)
  writeFileSync(path, lines.join('\n'))
  return path
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'eris-dev-ipc-'))
  h.userData = join(root, 'userData')
  // os.tmpdir() reads TMPDIR on every call, so snapshot folders land where this test can see them.
  process.env.TMPDIR = join(root, 'tmp')
  mkdirSync(process.env.TMPDIR, { recursive: true })
  mkdirSync(h.userData, { recursive: true })
  h.capture = async (index, question) => result(index, question)
  await import('../electron/dev/main')
  await new Promise((resolve) => setTimeout(resolve, 0))
})
afterAll(() => {
  process.env.TMPDIR = priorTmp
  rmSync(root, { recursive: true, force: true })
})

describe('Eris-Dev main process', () => {
  let stoppedRun = ''

  it('FR-029: opens a completed run read-only after it finishes', async () => {
    h.open.push([questionsFile(['First?', 'Second?', 'Third?'])])
    await invoke('dev:import')
    h.sent.length = 0
    await invoke('dev:start', { context: 8192, mode: 'agent', intentReplyMode: 'fallback' })
    expect(await idle()).toMatchObject({ completed: 3 })
    const [runId] = runDirs()
    const listed = (await invoke('dev:runs')) as Array<{ runId: string; state: string }>
    expect(listed).toEqual([expect.objectContaining({ runId, state: 'completed' })])
    const opened = (await invoke('dev:open', runId)) as { state: string; results: unknown[] }
    expect(opened).toMatchObject({ state: 'completed', invalid: [] })
    expect(opened.results).toHaveLength(3)
    await expect(invoke('dev:result', 2)).resolves.toMatchObject({ index: 2 })
    expect(snapshots()).toEqual([])
  })

  it('FR-026: a question stopped mid-capture is retried on resume, not skipped', async () => {
    h.open.push([questionsFile(['One?', 'Two?', 'Three?'])])
    await invoke('dev:import')
    let release: () => void = () => undefined
    const reached = new Promise<void>((resolve) => (release = resolve))
    h.capture = async (index, question, signal) => {
      if (index < 1) return result(index, question)
      release()
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
      return result(index, question, { status: 'cancelled' })
    }
    h.sent.length = 0
    await invoke('dev:start', { context: 8192, mode: 'agent', intentReplyMode: 'fallback' })
    await reached
    await invoke('dev:stop')
    expect(await idle()).toMatchObject({ completed: 1 })
    stoppedRun = runDirs().find((id) =>
      existsSync(join(h.userData, 'captures', id, '1.attempt-1.json'))
    )!
    const dir = join(h.userData, 'captures', stoppedRun)
    expect(existsSync(join(dir, '1.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'progress.json'), 'utf8'))).toMatchObject({
      state: 'stopped',
      completed: 1,
      interruptedAttempts: ['1.attempt-1.json']
    })
  })

  it('FR-027: concurrent resume calls admit exactly one operation', async () => {
    h.capture = async (index, question) => result(index, question)
    h.sent.length = 0
    const outcomes = await Promise.allSettled([
      invoke('dev:resume', stoppedRun),
      invoke('dev:resume', stoppedRun),
      invoke('dev:start', { context: 8192, mode: 'agent', intentReplyMode: 'fallback' })
    ])
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ status: 'fulfilled', value: { next: 1 } })
    expect(await idle()).toMatchObject({ completed: 3 })
    expect(snapshots()).toEqual([])
  })

  it('FR-028: a failed project snapshot leaves no copy behind and releases the lock', async () => {
    const project = join(root, 'project')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'index.js'), 'export const a = 1\n')
    writeFileSync(join(project, 'secret.txt'), 'x')
    chmodSync(join(project, 'secret.txt'), 0o000)
    h.open.push([project])
    await invoke('dev:project')
    try {
      await expect(
        invoke('dev:start', { context: 8192, mode: 'agent', intentReplyMode: 'fallback' })
      ).rejects.toThrow()
    } finally {
      chmodSync(join(project, 'secret.txt'), 0o600)
    }
    expect(snapshots()).toEqual([])
    await invoke('dev:project-kind', 'sample')
  })

  it('FR-021/022: compares 1,200 changes with true totals, pages and run compatibility', async () => {
    const lines = Array.from({ length: 1200 }, (_, i) => `How does case ${i} work?`)
    h.open.push([questionsFile(lines)])
    const corpus = (await invoke('dev:import')) as { questions: DevQuestion[] }
    h.capture = async (index, question) => result(index, question, { intent: 'explore' })
    h.sent.length = 0
    await invoke('dev:start', { context: 8192, mode: 'agent', intentReplyMode: 'fallback' })
    await idle()
    const current = readdirSync(join(h.userData, 'captures'))
      .map((id) => JSON.parse(readFileSync(join(h.userData, 'captures', id, 'run.json'), 'utf8')))
      .find((manifest) => manifest.questions.length === 1200)
    const earlier = join(root, 'earlier.jsonl')
    writeFileSync(
      earlier,
      [
        { ...current.header, fixture: { ...current.header.fixture, digest: 'another-project' } },
        ...corpus.questions.map((question, index) => result(index, question))
      ]
        .map((item) => JSON.stringify(item))
        .join('\n')
    )
    h.open.push([earlier])
    const comparison = (await invoke('dev:compare')) as DevComparison
    expect(comparison).toMatchObject({ matched: 1200, totalChanged: 1200 })
    expect(comparison.changed).toHaveLength(comparison.page.size)
    expect(comparison.compatibility.status).toBe('confounded')
    expect(comparison.compatibility.confounders.join(' ')).toMatch(/fixture changed/)
    const last = (await invoke('dev:compare-page', 1000)) as { changed: unknown[] }
    expect(last.changed).toHaveLength(200)
    const saved = JSON.parse(readFileSync(comparison.savedTo, 'utf8')) as DevComparison
    expect(saved.changed).toHaveLength(1200)

    h.open.push([questionsFile(['not a header line'])])
    await expect(invoke('dev:compare')).rejects.toThrow(/not valid JSON|no run header/)
  })

  it('FR-030: streams an export into place with no partial file left', async () => {
    const out = join(root, 'export.jsonl')
    h.save.push(out)
    const saved = (await invoke('dev:export', { sanitized: true })) as { records: number }
    expect(saved.records).toBe(1200)
    expect(readFileSync(out, 'utf8').trim().split('\n')).toHaveLength(1201)
    expect(readdirSync(root).filter((name) => name.includes('.partial-'))).toEqual([])
    expect(existsSync(`${out}.redaction.json`)).toBe(true)
  })
})

describe('FR-019/023 comparison identity', () => {
  it('a v1 record and a v2 record of the same question match', () => {
    const q = prepareQuestions('Explain soft deletes?\nWhat is a closure?', '.txt').questions
    const legacy = migrateLegacyIdentity(
      [1, 0].map((n, index) =>
        readCaptureRecord({ index, question: q[n]!.text, status: 'captured', requests: [] })
      )
    )
    const current = q.map((question, index) => result(index, question))
    // Reordered v1 records still align by content.
    expect(compareCaptures(legacy.records, current)).toMatchObject({
      matched: 2,
      added: [],
      removed: []
    })
    expect(legacy).toMatchObject({ migrated: 2, ambiguous: [] })
  })

  it('duplicated v1 text is surfaced as ambiguous', () => {
    const legacy = migrateLegacyIdentity(
      [0, 1].map((index) =>
        readCaptureRecord({ index, question: 'Same?', status: 'captured', requests: [] })
      )
    )
    expect(legacy.ambiguous).toHaveLength(2)
  })

  it('duplicate IDs are reported, never silently collapsed', () => {
    const [question] = prepareQuestions('Same?', '.txt').questions
    const comparison = compareCaptures(
      [result(0, question!)],
      [result(0, question!), result(1, question!)]
    )
    expect(comparison.duplicates.after).toEqual([question!.id])
    expect(comparison.matched).toBe(0)
  })

  it('scripted variants of the same text are separate cases', () => {
    const questions = prepareQuestions(
      [
        '{"question":"Tidy?","intentReply":{"intent":"review","confidence":0.9}}',
        '{"question":"Tidy?","intentReply":{"intent":"edit","confidence":0.9}}'
      ].join('\n'),
      '.jsonl'
    ).questions
    expect(questions[0]!.variant).not.toBe(questions[1]!.variant)
    const records = questions.map((question, index) =>
      result(index, question, { variant: question.variant })
    )
    expect(compareCaptures(records, [...records].reverse())).toMatchObject({
      matched: 2,
      totalChanged: 0
    })
  })

  it('explicit source IDs are kept and must be unique', () => {
    expect(prepareQuestions('{"id":"case-7","question":"A?"}', '.jsonl').questions[0]!.id).toBe(
      'case-7'
    )
    expect(() =>
      prepareQuestions('{"id":"x","question":"A?"}\n{"id":"x","question":"B?"}', '.jsonl')
    ).toThrow(/appears more than once/)
  })
})

describe('FR-020 comparison sees prompts, models and tool schemas', () => {
  const [question] = prepareQuestions('Explain soft deletes?', '.txt').questions
  const tool = (required: string[]) => ({
    type: 'function',
    function: { name: 'read_file', parameters: { type: 'object', required, properties: {} } }
  })
  const withRequest = (patch: Partial<DevResult['requests'][number]>) =>
    result(0, question!, {
      requests: [
        {
          purpose: 'agent',
          model: 'x',
          messages: [{ role: 'system', content: 'A' }],
          tools: [tool(['path'])],
          temperature: 0,
          ...patch
        }
      ]
    })

  it.each([
    ['instruction', { messages: [{ role: 'system', content: 'B' }] }, 'prompt', /line 1/],
    ['model', { model: 'y' }, 'model', undefined],
    ['sampling', { temperature: 0.7 }, 'sampling', undefined],
    ['required tool argument', { tools: [tool([])] }, 'toolSchemas', /lost required path/]
  ] as const)('a changed %s is visible', (_, patch, field, detail) => {
    const comparison = compareCaptures([withRequest({})], [withRequest(patch as never)])
    expect(comparison.changed[0]?.changes[field]).toBeDefined()
    if (detail) expect(comparison.changed[0]!.changes[field]!.detail).toMatch(detail)
  })

  it('task UUIDs and temporary roots alone are not changes', () => {
    const a = withRequest({
      messages: [
        {
          role: 'system',
          content: 'Task 3f2a1b4c-1111-4222-8333-444455556666 at /tmp/eris-dev-AbC/src'
        }
      ]
    })
    const b = withRequest({
      messages: [
        {
          role: 'system',
          content: 'Task 9e8d7c6b-1111-4222-8333-444455556666 at /tmp/eris-dev-XyZ/src'
        }
      ]
    })
    expect(compareCaptures([a], [b]).totalChanged).toBe(0)
  })

  it('a checker-version change is distinguished from a prompt change', () => {
    const header = {
      fixture: { kind: 'sample', digest: 'f', files: 2, omitted: [] },
      corpus: { id: 'c' },
      mode: 'agent',
      context: 8192,
      intentReplyMode: 'fallback',
      settingsDigest: 's',
      app: { gitSha: 'aaaaaaaa' },
      versions: { routing: 'r', prompt: 'p', schema: 'eris-dev-capture-v2', invariants: '1' }
    } as never
    expect(
      runCompatibility(header, {
        ...(header as object),
        versions: { ...(header as { versions: object }).versions, prompt: 'p2' }
      } as never)
    ).toMatchObject({ status: 'controlled', controlled: ['prompt p → p2'] })
    expect(
      runCompatibility(header, {
        ...(header as object),
        versions: { ...(header as { versions: object }).versions, invariants: '2' }
      } as never).status
    ).toBe('confounded')
    expect(runCompatibility(null, header).status).toBe('legacy')
  })
})

describe('FR-024/025 resume refuses invalid evidence and changed harnesses', () => {
  const [question] = prepareQuestions('A?', '.txt').questions

  it.each([
    ['missing fields', { index: 0, questionId: question!.id }, /missing|unknown status/],
    ['wrong case identity', { ...result(0, question!), questionId: 'other-1' }, /does not match/],
    ['wrong index', result(3, question!), /index 3/],
    ['interrupted attempt', result(0, question!, { status: 'cancelled' }), /interrupted/],
    ['unknown status', { ...result(0, question!), status: 'done' }, /unknown status/]
  ])('%s is a gap, not a completed case', (_, record, reason) => {
    expect(caseRecordProblem(record, 0, question)).toMatch(reason)
  })

  it('a valid record is accepted', () => {
    expect(caseRecordProblem(result(0, question!), 0, question)).toBeNull()
  })

  it('a changed harness fingerprint blocks resume even when versions match', () => {
    const header = {
      settingsDigest: 's',
      versions: { routing: 'r', prompt: 'p', harness: 'h1' },
      fixture: { digest: 'f' }
    } as never
    const same = { settingsDigest: 's', routing: 'r', prompt: 'p', fixtureDigest: 'f' }
    expect(resumeConflicts(header, { ...same, harness: 'h1' })).toEqual([])
    expect(resumeConflicts(header, { ...same, harness: 'h2' })).toEqual([
      'harness or source revision changed'
    ])
  })
})

describe('FR-031/032 import keeps chat requests and validates scripts', () => {
  it('an imperative before questions is a request, not a heading', () => {
    const preview = prepareQuestions(
      ['Fix the bug', ...Array.from({ length: 10 }, (_, i) => `Explain item ${i}?`)].join('\n'),
      '.txt'
    )
    expect(preview.questions[0]!.text).toBe('Fix the bug')
    expect(preview.excluded).toEqual([])
  })

  it('unnumbered lines in a mostly numbered file are kept; separators are not', () => {
    const preview = prepareQuestions(
      [
        'Title line',
        '====',
        ...Array.from({ length: 20 }, (_, i) => `${i + 1}. Q${i}?`),
        'Also fix the bug',
        '----'
      ].join('\n'),
      '.txt'
    )
    expect(preview.questions.map((q) => q.text)).toContain('Also fix the bug')
    expect(preview.excluded.map((line) => line.reason)).toEqual([
      'preamble before the first numbered question',
      'preamble before the first numbered question',
      'separator line'
    ])
  })

  it('an excluded line can be restored by its source line', () => {
    const preview = prepareQuestions('Coding questions:\nHow?\nWhy?', '.txt', '', { include: [1] })
    expect(preview.questions.map((q) => q.text)).toEqual(['Coding questions:', 'How?', 'Why?'])
  })

  it('long history is rejected, not silently truncated', () => {
    const history = [{ role: 'user', content: 'x'.repeat(32_001) }]
    expect(() =>
      prepareQuestions(JSON.stringify({ question: 'Then?', history }), '.jsonl')
    ).toThrow(/32,000/)
  })

  it.each([
    ['{"intent":"reveiw","confidence":0.9}', /unknown intent/],
    ['{"intent":"review","confidence":1.5}', /from 0 to 1/]
  ])('script %s fails normal import', (reply, message) => {
    expect(() => prepareQuestions(`{"question":"A?","intentReply":${reply}}`, '.jsonl')).toThrow(
      message
    )
  })

  it('a deliberately malformed script stays available when marked', () => {
    const [question] = prepareQuestions(
      '{"question":"A?","intentReplyMode":"malformed","intentReply":{"intent":"deploy","confidence":9}}',
      '.jsonl'
    ).questions
    expect(question).toMatchObject({
      intentReplyMalformed: true,
      intentReply: { intent: 'deploy' }
    })
  })
})

describe('FR-033/035 key-aware, export-scoped redaction', () => {
  it('redacts credential fields by name, nested and mixed-case', () => {
    const clean = new CaptureSanitizer({}).value({
      password: 'hunter2hunter2',
      token: 'abcdefghijklmnop',
      nested: { Client_Secret: 'shh', db: { PASSWORD: 'pw' } },
      headers: [
        { name: 'Authorization', value: 'Basic dXNlcjpwYXNz' },
        { name: 'Accept', value: 'json' }
      ],
      dsn: 'postgres://admin:s3cret@db.internal:5432/app',
      raw: 'Cookie: session=abcdef123456\npassword=pw12',
      tokenCount: 1200,
      maxTokens: '4096'
    })
    const text = JSON.stringify(clean)
    for (const secret of [
      'hunter2hunter2',
      'abcdefghijklmnop',
      '"shh"',
      '"pw"',
      'dXNlcjpwYXNz',
      's3cret',
      'abcdef123456',
      'pw12'
    ])
      expect(text).not.toContain(secret)
    expect(clean.headers[1]).toEqual({ name: 'Accept', value: 'json' })
    // Similar names that are not secrets keep their evidence.
    expect(clean.tokenCount).toBe(1200)
    expect(clean.maxTokens).toBe('4096')
  })

  it('markers are consistent within an export and unlinkable across exports', () => {
    const a = new CaptureSanitizer({})
    const b = new CaptureSanitizer({})
    const first = a.text('password=hunter2hunter2')
    expect(a.text('password=hunter2hunter2')).toBe(first)
    expect(b.text('password=hunter2hunter2')).not.toBe(first)
    expect(first).toMatch(/\[REDACTED:assigned-secret:[0-9a-f]{16}\]/)
    // An explicit shared key restores cross-export linkage on request.
    const shared = (text: string) => new CaptureSanitizer({ linkageKey: 'k' }).text(text)
    expect(shared('token=abcdefghij')).toBe(shared('token=abcdefghij'))
    expect(a.manifest()).toMatchObject({
      linkage: 'export-scoped',
      policy: 'eris-dev-redaction-v2'
    })
    expect(a.value(a.value({ password: 'x' }))).toEqual(a.value({ password: 'x' }))
  })
})
