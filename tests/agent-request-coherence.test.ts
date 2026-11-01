import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { captureQuestion } from '../electron/dev/capture'
import { classifyIntent } from '../electron/main/services/chat-router'
import { conservativeFallback } from '../electron/main/services/task-resolver'
import { requestInvariantFindings } from '../electron/main/services/agent/request-invariants'
import { asksForCodeExample, asksForDesignAnswer } from '../src/shared/agent-contract'
import { interpretRequest, requestConstraints } from '../src/shared/task-interpretation'
import type { TaskContract } from '../src/shared/task-contract'
import type { DevResult } from '../src/shared/eris-dev'

/**
 * Acceptance cases from docs/reviews/eris-dev-latest-2026-10-23 (LR-001 … LR-017).
 * Q-numbers are the 1-based corpus questions the review cites. Each case asserts the
 * compiled request at the production boundary as well as the internal task.
 */
const Q1 =
  "I'm trying to add database connection pooling for an internal admin dashboard. What's the best way?"
const Q5 = 'Explain how to implement rotating secrets without downtime with Redis for caching?'
const Q6 =
  'Can you write per-user rate limiting so the happy path is obvious and errors are explicit?'
const Q13 =
  'How should I structure the code for forcing logout across all devices using Express and TypeScript?'
const Q14 = 'I need a practical example of database connection pooling in Python?'
const Q28 = 'Show me an example of per-user rate limiting following clean architecture principles?'
const Q42 =
  'I need to implement transactional emails using templates with good test coverage. How would you approach it?'
const Q43 =
  'Show me both a simple and a more robust version of error boundaries that support retry?'

const roots: string[] = []
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'eris-coherence-'))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content)
  roots.push(root)
  return root
}
const JS = { 'package.json': '{"name":"fixture"}', 'index.js': 'export const x = 1\n' }
const PHP = { 'composer.json': '{"name":"acme/site"}', 'index.php': '<?php echo 1;\n' }
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

async function capture(text: string, workspace = fixture(JS)) {
  const result = await captureQuestion(
    0,
    text,
    workspace,
    8192,
    'agent',
    new AbortController().signal
  )
  expect(result.status, result.detail).toBe('captured')
  const task = result.task as TaskContract
  const agent = result.requests.find((request) => request.purpose === 'agent')!
  const system = (agent.messages as Array<{ role: string; content: string }>)
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n')
  const tools = (agent.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)
  const currentTurn =
    (agent.messages as Array<{ role: string; content: string }>).find(
      (message) => message.role === 'user' && message.content.startsWith('TASK CONTRACT\n')
    )?.content ?? system
  return { result, task, system, currentTurn, tools }
}
const GROUNDING =
  /grounded in (?:the )?(?:inspected files|files that were read)|Inspect the relevant (?:files|sources)|Return findings with file paths|real file paths and symbols it read|Read the matching source files/i

describe('LR-001/LR-002/LR-014 generic tasks compile without workspace grounding', () => {
  it.each([
    ['Q1', Q1],
    ['Q28', Q28]
  ])('%s has no mandatory file-grounding criterion or instruction', async (_, text) => {
    const { task, system, currentTurn, result } = await capture(text)
    expect(task.scope.applicability).toBe('generic')
    expect(task.acceptanceCriteria.filter((line) => GROUNDING.test(line))).toEqual([])
    expect(system).not.toMatch(GROUNDING)
    expect(result.findingIds).toEqual([])
    // The model-facing contract carries applicability; the internal root is kept.
    const facing = JSON.parse(currentTurn.split('TASK CONTRACT\n')[1]!.split('\n')[0]!)
    expect(facing.scope).toMatchObject({
      applicability: 'generic',
      evidence: 'none',
      project: null
    })
    expect(task.scope.projectRoot).toBeTruthy()
  })

  it('a named source file still requires inspected-source evidence', async () => {
    const { task, currentTurn } = await capture('Explain the implementation in src/auth.ts')
    expect(task.scope.applicability).toBe('selected-project')
    expect(task.acceptanceCriteria[0]).toMatch(/grounded in the files that were read/)
    const facing = JSON.parse(currentTurn.split('TASK CONTRACT\n')[1]!.split('\n')[0]!)
    expect(facing.scope).toMatchObject({ applicability: 'selected-project', evidence: 'required' })
  })

  it('read-only code examples and designs are never told to return findings', async () => {
    for (const text of [Q28, Q13, 'Where is the divide function defined?']) {
      expect((await capture(text)).system).not.toContain('Return findings with file paths')
    }
  })
})

describe('LR-003/LR-004/LR-005 artifact recognition', () => {
  it('Q14: a practical-example request is a code example with an implementation obligation', () => {
    const reading = interpretRequest({ text: Q14, intent: 'answer', canEdit: false, revision: 1 })
    expect(reading.artifact).toBe('code-example')
    expect(reading.obligations.some((item) => item.kind === 'implementation')).toBe(true)
    expect(reading.trace?.artifactRule).toBe('code-example-request')
  })

  it('example operands stay explanations and reviews', () => {
    expect(asksForCodeExample('Explain why this example fails')).toBe(false)
    expect(asksForCodeExample('Review this example')).toBe(false)
    expect(asksForCodeExample('Show me where the rate limit middleware is')).toBe(false)
  })

  it('Q6: “write” binds to the behavior, prose stays prose, a file stays a patch', async () => {
    const q6 = await capture(Q6)
    expect(q6.result.artifact).toBe('code-example')
    expect(q6.task.authority.edit).toBe(false)
    const kinds = q6.task.interpretation!.obligations.map((item) => item.kind)
    expect(kinds).toEqual(['implementation', 'constraint'])
    expect(q6.task.interpretation!.obligations[1]!.source?.text).toBe(
      'so the happy path is obvious and errors are explicit'
    )
    expect(asksForCodeExample('Write a summary of rate limiting')).toBe(false)
    expect(classifyIntent('Write the limiter into src/limit.ts', 'agent')).toBe('edit')
  })

  it('Q28: “show me an example” is generation; “show me where” is a lookup', async () => {
    const example = await capture(Q28)
    expect(example.result.intent).toBe('answer')
    expect(example.result.artifact).toBe('code-example')
    expect(example.tools).toEqual([])
    expect(classifyIntent('Show me where rate limiting is implemented', 'agent')).toBe('explore')
  })
})

describe('LR-006 the edit fallback keeps the requested deliverable', () => {
  it.each([
    [Q5, 'answer', 'explanation'],
    [Q1, 'answer', 'design'],
    ['Give me a migration plan for moving sessions to Redis', 'plan', 'plan']
  ] as const)('“%s” → %s / %s', async (text, intent, artifact) => {
    const { result } = await capture(text)
    expect(result.intent).toBe(intent)
    expect(result.artifact).toBe(artifact)
  })

  it('an ambiguous imperative stays a recorded plan and never gains effects', () => {
    expect(conservativeFallback('Could we make this easier to use?', 'edit')).toBe('plan')
    for (const text of [Q5, Q1, 'Add caching', 'Could we make this easier to use?'])
      expect(['edit', 'run']).not.toContain(conservativeFallback(text, 'edit'))
  })

  it.each(['malformed', 'timeout'] as const)(
    'a %s resolver reply grants no write or run authority',
    async (mode) => {
      const result = await captureQuestion(
        0,
        'Add retry logic to the payment client',
        fixture(JS),
        8192,
        'agent',
        new AbortController().signal,
        { intentReplyMode: mode }
      )
      const task = result.task as TaskContract
      expect(task.authority.edit).toBe(false)
      expect(task.authority.execute).toBe('none')
    }
  )
})

describe('LR-007 structural phrasing is a design request', () => {
  it.each(['would', 'should', 'can'])('“how %s I structure the code for …”', (modal) => {
    expect(asksForDesignAnswer(`How ${modal} I structure the code for forcing logout?`)).toBe(true)
  })
  it('language data shapes are not architecture', () => {
    expect(asksForDesignAnswer('How should I structure a struct for a 3D point in Rust?')).toBe(
      false
    )
    expect(asksForDesignAnswer('How should I structure this JSON payload?')).toBe(false)
  })
})

describe('LR-008 requested output multiplicity', () => {
  it('Q43: two versions are two components; one version leaves the other pending', async () => {
    const { task, result } = await capture(Q43)
    const parts = task.interpretation!.obligations.filter((item) => item.kind === 'implementation')
    expect(parts.map((item) => item.component)).toEqual(['simple', 'robust'])
    expect(result.findingIds).not.toContain('output-cardinality-loss')
    // Mutation: dropping one component must be caught by the independent invariant.
    const mutated = structuredClone(task)
    mutated.interpretation!.obligations = mutated.interpretation!.obligations.filter(
      (item) => item.component !== 'robust'
    )
    const ids = requestInvariantFindings({
      task: mutated,
      requests: [],
      imagesEnabled: false,
      mcpToolCount: 0
    }).map((finding) => finding.id)
    expect(ids).toContain('output-cardinality-loss')
  })
})

describe('LR-009 testing requirements in non-code replies', () => {
  it('Q42 gets a testing-strategy obligation that claims no execution', () => {
    const reading = interpretRequest({ text: Q42, intent: 'answer', canEdit: false, revision: 1 })
    const tests = reading.obligations.filter((item) => item.kind === 'tests')
    expect(tests).toHaveLength(1)
    expect(tests[0]!.text).toMatch(/test boundaries, fixtures, and failure modes/)
    expect(tests[0]!.text).toMatch(/Do not claim any test was written or run/)
  })
  it('seeding test data is a domain noun, not a test request', () => {
    const reading = interpretRequest({
      text: 'Seed realistic test data for the staging database',
      intent: 'answer',
      canEdit: false,
      revision: 1
    })
    expect(reading.obligations.some((item) => item.kind === 'tests')).toBe(false)
  })
})

describe('LR-010 constraints are evidence-linked and bounded', () => {
  it('keeps exact phrases, skips negated effects and topic names', () => {
    expect(requestConstraints(Q5).phrases).toEqual(['without downtime'])
    expect(requestConstraints('Fix the parser without running tests').phrases).toEqual([])
    expect(requestConstraints('Explain database connection pooling').phrases).toEqual([])
  })
  it('counts clauses past the bound instead of dropping them silently', () => {
    const text =
      'Write a cache so reads are fast, that supports eviction, following SOLID, without locks, ensuring isolation.'
    const stated = requestConstraints(text)
    expect(stated.phrases).toHaveLength(3)
    expect(stated.unparsed).toBe(2)
  })
})

describe('LR-011/LR-012 scope does not depend on the open fixture or artifact', () => {
  it('a generic Python request compiles the same contract in JavaScript and PHP fixtures', async () => {
    const js = await capture(Q14, fixture(JS))
    const php = await capture(Q14, fixture(PHP))
    const semantic = (task: TaskContract) => ({
      scope: task.scope.applicability,
      authority: task.authority,
      artifact: task.interpretation!.artifact,
      obligations: task.interpretation!.obligations,
      stackFit: task.interpretation!.stackFit,
      acceptance: task.acceptanceCriteria
    })
    expect(semantic(js.task)).toEqual(semantic(php.task))
    const contractBlock = (system: string) =>
      system.split('PROJECT AND CONVERSATION CONTEXT')[0]!.replace(/"taskId":"[^"]+"/, '')
    expect(contractBlock(js.system)).toEqual(contractBlock(php.system))
    expect(js.system).not.toMatch(/open project uses/)
  })

  it('equivalent design and plan phrasing keep the same scope without a reference', async () => {
    const design = await capture('How would you design a job queue with retries?')
    const plan = await capture("What's the best way to design a job queue with retries?")
    expect(design.task.scope.applicability).toBe('generic')
    expect(plan.task.scope.applicability).toBe('generic')
  })

  it('a hypothetical project of another stack is not the open project', async () => {
    const { task } = await capture(
      'In an existing Next.js project, how should I structure the code for feature flags?'
    )
    expect(task.scope.applicability).toBe('generic')
  })
})

describe('LR-013 generic tool exposure', () => {
  it('a generic explanation that keeps read tools does not get orientation tools inline', async () => {
    const { result, tools } = await capture('Explain how JWT refresh tokens work')
    expect(result.intent).toBe('explore')
    expect(tools).not.toContain('tree')
    expect(tools).not.toContain('git_status')
    expect(tools).not.toContain('git_diff')
  })
  it('a repository explanation keeps the reads it needs', async () => {
    const { tools } = await capture('Explain how division works in this project')
    expect(tools).toEqual(expect.arrayContaining(['read_file', 'grep']))
  })
})

describe('LR-016 worker by deliverable, not length', () => {
  it('a short practical-example request never gets the sentence-only Fast worker', async () => {
    const { result } = await capture('I need an example of a Go worker pool?')
    expect(result.agent).not.toBe('Fast')
    expect(result.artifact).toBe('code-example')
  })
})

describe('LR-017 invariants detect scope and artifact loss independently', () => {
  const base = async (text: string) => (await capture(text)).task
  const ids = (task: TaskContract, system = '') =>
    requestInvariantFindings({
      task,
      requests: [
        {
          purpose: 'agent',
          messages: [{ role: 'system', content: `TASK CONTRACT\n${system}` }],
          tools: []
        }
      ],
      imagesEnabled: false,
      mcpToolCount: 0
    }).map((finding) => finding.id)

  it('flags a generic request that must ground itself in project files', async () => {
    const task = await base(Q1)
    task.acceptanceCriteria = ['The plan is grounded in inspected files.']
    expect(ids(task)).toContain('generic-requires-project-evidence')
  })

  it('flags an explicit example whose contract lost the implementation', async () => {
    const task = await base(Q14)
    task.interpretation!.obligations = [{ id: 'answer-1', kind: 'answer', text: 'Answer.' }]
    task.interpretation!.artifact = 'explanation'
    expect(ids(task)).toContain('explicit-example-without-implementation')
  })

  it('flags a findings format on a read-only code example', async () => {
    const task = await base(Q28)
    expect(ids(task, 'This task is read-only. Return findings with file paths.')).toContain(
      'read-only-findings-format'
    )
  })

  it('correct captures of the cited questions have no findings', async () => {
    const results: DevResult[] = []
    for (const text of [Q1, Q5, Q6, Q13, Q14, Q28, Q42, Q43])
      results.push((await capture(text)).result)
    expect(
      results.filter((result) => result.findingIds.length).map((r) => [r.question, r.findingIds])
    ).toEqual([])
  })
})
