import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const model = vi.hoisted(() => ({ replies: [] as string[] }))

vi.mock('../electron/main/services/chat-runtime', () => ({
  streamModelChat: async function* () {
    yield model.replies.shift() ?? 'DONE: Missing simulated response.'
  }
}))

vi.mock('../electron/main/services/verify', () => ({
  runVerify: async () => ({
    ok: true,
    skipped: true,
    command: '',
    detail: 'corpus verification skipped'
  })
}))

vi.mock('../electron/main/services/shell-run', () => ({
  runWorkspaceCommand: async () => ({
    ok: true,
    code: 0,
    stdout: '100 simulated checks passed',
    stderr: '',
    timedOut: false
  })
}))

vi.mock('../electron/main/services/mcp-runtime', () => ({
  syncMcpRuntime: async () => undefined,
  listMcpTools: () => [],
  isMcpToolName: () => false,
  callMcpTool: async () => ({ ok: false, detail: 'no mcp' }),
  formatLiveMcpToolsPrompt: () => ''
}))

vi.mock('../electron/main/services/workspace-search', () => ({
  retrieveContextAsync: async () => ({ ok: true, paths: [], detail: '' }),
  workspaceGlob: () => ({ ok: true, detail: '' }),
  workspaceGrep: async () => ({ ok: true, detail: '' })
}))

vi.mock('../electron/main/services/code-index', () => ({
  findReferences: () => ({ ok: true, detail: '' }),
  findSymbols: () => ({ ok: true, detail: '' }),
  relatedFiles: () => ({ ok: true, detail: '' }),
  formatIndexSummary: () => ''
}))

import { runAgentWithWorkspaceTools } from '../electron/main/services/agent/loop'
import { parseToolCalls } from '../electron/main/services/agent/tool-parsing'
import { validateToolArguments } from '../electron/main/services/agent/tool-validation'
import { classifyIntent } from '../electron/main/services/chat-router'
import { getDefaults } from '../electron/main/services/settings'
import { getToolContract } from '../electron/main/services/tool-registry'
import type { AgentRunnerEvent } from '../electron/main/services/agent/types'
import { chatAgentForTurn } from '../src/shared/agent-contract'
import type { AgentToolsCeiling, ChatIntent, TurnPlan } from '../src/shared/settings-schema'
import {
  AGENT_QUESTION_CORPUS,
  type AgentQuestionCase,
  type CorpusAgent
} from './fixtures/agent-question-corpus'

let workspacePath = ''

type NaturalQuestionCase = {
  id: string
  question: string
  intent: ChatIntent
  agent: ReturnType<typeof chatAgentForTurn>
  simulatedResponses: string[]
  expectedToken: string
  outputPath?: string
}

const naturalQuestionFixture = fileURLToPath(
  new URL('./fixtures/10000-natural-diverse-coding-questions.txt', import.meta.url)
)
const packagedNaturalQuestionFixture = fileURLToPath(
  new URL('../resources/evals/10000-natural-diverse-coding-questions.txt', import.meta.url)
)

function loadNaturalQuestions(): Array<{ id: string; question: string }> {
  return readFileSync(naturalQuestionFixture, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.match(/^(\d+)\.\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => match != null)
    .map((match) => ({ id: match[1]!, question: match[2]!.trim() }))
}

const naturalQuestions = loadNaturalQuestions()

function naturalSourceModule(id: string, question: string): string {
  return [
    `/** Complete deterministic implementation fixture for ${id}. */`,
    `export const smokeQuestionId = '${id}'`,
    `export const sourceQuestion = ${JSON.stringify(question)}`,
    '',
    'export type SmokeResult = { id: string; question: string; processed: boolean }',
    '',
    'export function processNaturalQuestion(): SmokeResult {',
    '  return { id: smokeQuestionId, question: sourceQuestion, processed: true }',
    '}',
    '',
    'export function formatNaturalQuestionResult(result: SmokeResult): string {',
    "  return `${result.id}: ${result.processed ? 'processed' : 'pending'} — ${result.question}`",
    '}',
    ''
  ].join('\n')
}

function naturalTestModule(id: string): string {
  return [
    "import { describe, expect, it } from 'vitest'",
    `import { processNaturalQuestion } from '../../src/natural-question-smoke/question-${id.replace('natural-question-', '')}'`,
    '',
    `describe('${id}', () => {`,
    "  it('preserves the source question and reports successful processing', () => {",
    '    const result = processNaturalQuestion()',
    `    expect(result.id).toBe('${id}')`,
    '    expect(result.question.length).toBeGreaterThan(20)',
    '    expect(result.processed).toBe(true)',
    '  })',
    '})',
    ''
  ].join('\n')
}

beforeAll(() => {
  workspacePath = mkdtempSync(join(tmpdir(), 'eris-agent-corpus-'))
  mkdirSync(join(workspacePath, 'src'), { recursive: true })
  writeFileSync(
    join(workspacePath, 'README.md'),
    '# Agent corpus fixture\n\nA deterministic workspace for routing and response tests.\n'
  )
  writeFileSync(
    join(workspacePath, 'src', 'catalog.ts'),
    [
      'export const parseConfig = () => undefined',
      'export const loadSettings = () => undefined',
      'export const saveSettings = () => undefined',
      'export const routeMessage = () => undefined',
      'export const classifyIntent = () => undefined',
      'export const runAgent = () => undefined',
      'export const executeTool = () => undefined',
      'export const validateTool = () => undefined',
      'export const createCheckpoint = () => undefined',
      'export const restoreCheckpoint = () => undefined',
      'export const streamChat = () => undefined',
      'export const stopChat = () => undefined',
      'export const readWorkspace = () => undefined',
      'export const writeWorkspace = () => undefined',
      'export const searchSymbols = () => undefined',
      'export const findReferences = () => undefined',
      'export const formatDiff = () => undefined',
      'export const applyPatch = () => undefined',
      'export const collectDiagnostics = () => undefined',
      'export const publishRelease = () => undefined',
      ''
    ].join('\n')
  )
})

afterAll(() => {
  rmSync(workspacePath, { recursive: true, force: true })
})

const agentNames: Record<CorpusAgent, string> = {
  explainer: 'Explainer',
  fast: 'Fast',
  composer: 'Composer',
  reviewer: 'Reviewer',
  planner: 'Planner',
  verifier: 'Verification'
}

function planFor(testCase: AgentQuestionCase): TurnPlan {
  const policy: AgentToolsCeiling =
    testCase.intent === 'answer' ? 'none' : testCase.intent === 'edit' ? 'edit' : 'read'
  return {
    intent: testCase.intent,
    agentId: testCase.agent,
    agentName: agentNames[testCase.agent],
    mode: testCase.mode,
    models: { chat: 'builtin:composer-lite', tools: 'builtin:composer-lite' },
    toolPolicy: policy,
    requiresTools: testCase.intent !== 'answer',
    escalateToFull: false,
    reason: `corpus ${testCase.id}`,
    method: 'manual'
  }
}

function naturalCaseFor(entry: { id: string; question: string }): NaturalQuestionCase {
  const intent = classifyIntent(entry.question, 'agent', ['README.md', 'src/catalog.ts'])
  const agent = chatAgentForTurn({ mode: 'agent', intent, text: entry.question })
  const expectedToken = `natural-question-${entry.id}`
  const toolResponses: string[] = []
  let outputPath: string | undefined

  if (intent === 'edit') {
    outputPath = `src/natural-question-smoke/question-${entry.id}.ts`
    toolResponses.push(
      JSON.stringify({
        name: 'write_file',
        path: outputPath,
        content: naturalSourceModule(expectedToken, entry.question)
      })
    )
    toolResponses.push(
      JSON.stringify({
        name: 'write_file',
        path: `tests/natural-question-smoke/question-${entry.id}.test.ts`,
        content: naturalTestModule(expectedToken)
      })
    )
  } else if (intent === 'verify' || intent === 'run') {
    toolResponses.push(JSON.stringify({ name: 'run', command: 'npm test' }))
  } else if (!['answer', 'capability'].includes(intent)) {
    toolResponses.push(JSON.stringify({ name: 'read_file', path: 'src/catalog.ts' }))
  }

  const completionPrefix: Record<ChatIntent, string> = {
    answer: 'Answer complete',
    capability: 'Answer complete',
    explore: 'Exploration complete',
    edit: 'DONE: Implementation complete',
    plan: 'Plan complete',
    review: 'Review complete',
    verify: 'Verification complete: npm test passed',
    run: 'DONE: Command completed'
  }
  const answer = `${completionPrefix[intent]} ${expectedToken}: processed by ${agent}.`
  return {
    id: entry.id,
    question: entry.question,
    intent,
    agent,
    simulatedResponses: [...toolResponses, answer],
    expectedToken,
    outputPath
  }
}

function naturalPlanFor(testCase: NaturalQuestionCase): TurnPlan {
  const policy: AgentToolsCeiling =
    testCase.intent === 'edit'
      ? 'edit'
      : testCase.intent === 'run'
        ? 'full'
        : ['answer', 'capability'].includes(testCase.intent)
          ? 'none'
          : 'read'
  return {
    intent: testCase.intent,
    agentId: testCase.agent,
    agentName: agentNames[testCase.agent as CorpusAgent] ?? testCase.agent,
    mode: 'agent',
    models: { chat: 'builtin:composer-lite', tools: 'builtin:composer-lite' },
    toolPolicy: policy,
    requiresTools: policy !== 'none',
    escalateToFull: false,
    reason: `natural question corpus ${testCase.id}`,
    method: 'manual'
  }
}

async function runCase(testCase: AgentQuestionCase): Promise<AgentRunnerEvent[]> {
  model.replies.splice(0, model.replies.length, ...testCase.simulatedResponses)
  const events: AgentRunnerEvent[] = []
  for await (const event of runAgentWithWorkspaceTools({
    workspacePath,
    settings: getDefaults(),
    model: 'builtin:composer-lite',
    messages: [{ role: 'user', content: testCase.question }],
    temperature: 0,
    getSecret: () => null,
    mode: testCase.mode,
    turnPlan: planFor(testCase),
    mcp: 'off',
    approveCommand: async () => true
  })) {
    events.push(event)
  }
  return events
}

async function runNaturalCase(testCase: NaturalQuestionCase): Promise<AgentRunnerEvent[]> {
  model.replies.splice(0, model.replies.length, ...testCase.simulatedResponses)
  const events: AgentRunnerEvent[] = []
  for await (const event of runAgentWithWorkspaceTools({
    workspacePath,
    settings: getDefaults(),
    model: 'builtin:composer-lite',
    messages: [{ role: 'user', content: testCase.question }],
    temperature: 0,
    getSecret: () => null,
    mode: 'agent',
    turnPlan: naturalPlanFor(testCase),
    mcp: 'off',
    approveCommand: async () => true
  })) {
    events.push(event)
  }
  return events
}

function lastAnswer(events: AgentRunnerEvent[]): string {
  return (
    [...events]
      .reverse()
      .find(
        (event): event is Extract<AgentRunnerEvent, { type: 'answer' }> => event.type === 'answer'
      )?.text ?? ''
  )
}

describe('10,000-question agent build corpus', () => {
  it('contains exactly 10,000 unique questions across coding, design, and applications', () => {
    expect(AGENT_QUESTION_CORPUS).toHaveLength(10_000)
    expect(new Set(AGENT_QUESTION_CORPUS.map((entry) => entry.id)).size).toBe(10_000)
    expect(new Set(AGENT_QUESTION_CORPUS.map((entry) => entry.question)).size).toBe(10_000)
    expect(new Set(AGENT_QUESTION_CORPUS.map((entry) => entry.simulatedAnswer)).size).toBe(10_000)
    expect(
      Object.fromEntries(
        ['coding', 'design', 'applications'].map((category) => [
          category,
          AGENT_QUESTION_CORPUS.filter((entry) => entry.category === category).length
        ])
      )
    ).toEqual({ coding: 4_000, design: 3_000, applications: 3_000 })
    expect(
      Object.fromEntries(
        [...new Set(AGENT_QUESTION_CORPUS.map((entry) => entry.intent))].map((intent) => [
          intent,
          AGENT_QUESTION_CORPUS.filter((entry) => entry.intent === intent).length
        ])
      )
    ).toEqual({
      answer: 1_667,
      explore: 1_667,
      edit: 1_667,
      review: 1_667,
      plan: 1_666,
      verify: 1_666
    })
  })

  it('routes all 10,000 questions and validates every simulated response contract', () => {
    const failures: string[] = []
    const expectedTool: Record<AgentQuestionCase['intent'], string | null> = {
      answer: null,
      explore: 'read_file',
      edit: 'write_file',
      review: 'read_file',
      plan: 'read_file',
      verify: 'run'
    }

    for (const testCase of AGENT_QUESTION_CORPUS) {
      const classified = classifyIntent(testCase.question, testCase.mode, [
        'README.md',
        'src/catalog.ts'
      ])
      if (classified !== testCase.intent) {
        failures.push(`${testCase.id}: intent ${classified}, expected ${testCase.intent}`)
      }
      const agent = chatAgentForTurn({
        mode: testCase.mode,
        intent: testCase.intent,
        text: testCase.question
      })
      if (agent !== testCase.agent) {
        failures.push(`${testCase.id}: agent ${agent}, expected ${testCase.agent}`)
      }
      if (!testCase.simulatedAnswer.includes(testCase.expectedToken)) {
        failures.push(`${testCase.id}: simulated answer is missing ${testCase.expectedToken}`)
      }

      const calls = testCase.simulatedResponses.flatMap((response) => parseToolCalls(response))
      const toolName = expectedTool[testCase.intent]
      if (toolName == null) {
        if (calls.length > 0) failures.push(`${testCase.id}: answer unexpectedly called a tool`)
      } else if (calls.length !== 1 || calls[0]?.name !== toolName) {
        failures.push(
          `${testCase.id}: expected one ${toolName} call, received ${calls.map((call) => call.name).join(', ') || 'none'}`
        )
      } else {
        const validation = validateToolArguments(
          calls[0].args,
          getToolContract(calls[0].name)?.schema
        )
        if (!validation.ok)
          failures.push(`${testCase.id}: invalid tool arguments: ${validation.errors.join('; ')}`)
      }
    }

    expect(failures.slice(0, 20)).toEqual([])
  })

  it('runs a balanced 90-case sample through the complete agent loop', async () => {
    const readmeBefore = readFileSync(join(workspacePath, 'README.md'), 'utf8')
    const catalogBefore = readFileSync(join(workspacePath, 'src', 'catalog.ts'), 'utf8')
    const representativeCases = ['coding', 'design', 'applications'].flatMap((category) =>
      ['answer', 'explore', 'edit', 'review', 'plan', 'verify'].flatMap((intent) =>
        AGENT_QUESTION_CORPUS.filter(
          (entry) => entry.category === category && entry.intent === intent
        ).slice(0, 5)
      )
    )
    expect(representativeCases).toHaveLength(90)

    for (const testCase of representativeCases) {
      const label = `${testCase.id}: ${testCase.question}`
      const events = await runCase(testCase)
      expect(lastAnswer(events), `${label} should post its simulated answer`).toContain(
        testCase.expectedToken
      )
      expect(
        events.some((event) => event.type === 'progress' && event.incomplete === true),
        `${label} should finish without an incomplete marker`
      ).toBe(false)
      expect(model.replies, `${label} should consume every simulated model response`).toHaveLength(
        0
      )

      const tools = events
        .filter(
          (event): event is Extract<AgentRunnerEvent, { type: 'tool' }> => event.type === 'tool'
        )
        .map((event) => event.tool)
      if (testCase.intent === 'answer') {
        expect(tools, `${label} should answer without tools`).toHaveLength(0)
      } else if (testCase.intent === 'edit') {
        expect(testCase.outputPath).toBeTruthy()
        expect(
          readFileSync(join(workspacePath, testCase.outputPath!), 'utf8'),
          `${label} should write its requested module`
        ).toContain(testCase.id)
        expect(tools.some((tool) => tool.name === 'write_file' && tool.status === 'ok')).toBe(true)
      } else if (testCase.intent === 'verify') {
        expect(tools.some((tool) => tool.name === 'run' && tool.status === 'ok')).toBe(true)
      } else {
        expect(tools.some((tool) => tool.name === 'read_file' && tool.status === 'ok')).toBe(true)
      }
    }

    expect(readFileSync(join(workspacePath, 'README.md'), 'utf8')).toBe(readmeBefore)
    expect(readFileSync(join(workspacePath, 'src', 'catalog.ts'), 'utf8')).toBe(catalogBefore)
  }, 30_000)
})

describe('attached 10,000 natural coding chat questions', () => {
  it('ships the exact reviewed corpus with the desktop app', () => {
    expect(readFileSync(packagedNaturalQuestionFixture, 'utf8')).toBe(
      readFileSync(naturalQuestionFixture, 'utf8')
    )
  })

  it('loads all numbered questions as unique test data and ignores the document heading', () => {
    expect(naturalQuestions).toHaveLength(10_000)
    expect(naturalQuestions.map((entry) => Number(entry.id))).toEqual(
      Array.from({ length: 10_000 }, (_, index) => index + 1)
    )
    expect(new Set(naturalQuestions.map((entry) => entry.question)).size).toBe(10_000)
    expect(naturalQuestions.every((entry) => entry.question.length >= 20)).toBe(true)
  })

  it('processes all 10,000 questions through routing, agent selection, and response contracts', () => {
    const failures: string[] = []
    const intentCounts = new Map<ChatIntent, number>()
    const agentCounts = new Map<string, number>()

    for (const entry of naturalQuestions) {
      const testCase = naturalCaseFor(entry)
      intentCounts.set(testCase.intent, (intentCounts.get(testCase.intent) ?? 0) + 1)
      agentCounts.set(testCase.agent, (agentCounts.get(testCase.agent) ?? 0) + 1)

      if (!testCase.simulatedResponses.at(-1)?.includes(testCase.expectedToken)) {
        failures.push(`${entry.id}: simulated answer lost its trace token`)
      }
      if (testCase.intent === 'edit' && testCase.agent !== 'composer') {
        failures.push(`${entry.id}: edit routed to ${testCase.agent}`)
      }
      if (testCase.intent === 'plan' && testCase.agent !== 'planner') {
        failures.push(`${entry.id}: plan routed to ${testCase.agent}`)
      }
      if (testCase.intent === 'review' && testCase.agent !== 'reviewer') {
        failures.push(`${entry.id}: review routed to ${testCase.agent}`)
      }
      if (testCase.intent === 'verify' && testCase.agent !== 'verifier') {
        failures.push(`${entry.id}: verification routed to ${testCase.agent}`)
      }

      for (const call of testCase.simulatedResponses.flatMap((response) =>
        parseToolCalls(response)
      )) {
        const contract = getToolContract(call.name)
        if (!contract) {
          failures.push(`${entry.id}: unknown simulated tool ${call.name}`)
          continue
        }
        const validation = validateToolArguments(call.args, contract.schema)
        if (!validation.ok) {
          failures.push(`${entry.id}: invalid ${call.name}: ${validation.errors.join('; ')}`)
        }
      }
    }

    expect(failures.slice(0, 20)).toEqual([])
    expect([...intentCounts.values()].reduce((sum, count) => sum + count, 0)).toBe(10_000)
    expect([...agentCounts.values()].reduce((sum, count) => sum + count, 0)).toBe(10_000)
    expect(agentCounts.size).toBeGreaterThanOrEqual(2)
  })

  it('runs 120 natural questions through the complete chat agent loop', async () => {
    const routedCases = naturalQuestions.map(naturalCaseFor)
    const byAgent = [...new Set(routedCases.map((entry) => entry.agent))].flatMap((agent) =>
      routedCases.filter((entry) => entry.agent === agent).slice(0, 20)
    )
    const selectedIds = new Set(byAgent.map((entry) => entry.id))
    const representativeCases = [
      ...byAgent,
      ...routedCases.filter((entry, index) => index % 37 === 0 && !selectedIds.has(entry.id))
    ].slice(0, 120)
    expect(representativeCases).toHaveLength(120)

    for (const testCase of representativeCases) {
      const label = `natural question ${testCase.id}: ${testCase.question}`
      const events = await runNaturalCase(testCase)
      expect(lastAnswer(events), `${label} should post its simulated answer`).toContain(
        testCase.expectedToken
      )
      expect(
        events.some((event) => event.type === 'progress' && event.incomplete === true),
        `${label} should complete`
      ).toBe(false)
      expect(model.replies, `${label} should consume every simulated response`).toHaveLength(0)

      const successfulTools = events.filter(
        (event): event is Extract<AgentRunnerEvent, { type: 'tool' }> =>
          event.type === 'tool' && event.tool.status === 'ok'
      )
      if (testCase.outputPath) {
        expect(readFileSync(join(workspacePath, testCase.outputPath), 'utf8')).toContain(
          testCase.expectedToken
        )
        expect(successfulTools.some((event) => event.tool.name === 'write_file')).toBe(true)
      } else if (naturalPlanFor(testCase).requiresTools) {
        expect(successfulTools.length, `${label} should execute its routed tool`).toBeGreaterThan(0)
      } else {
        expect(successfulTools, `${label} should not need tools`).toHaveLength(0)
      }
    }
  }, 30_000)
})
