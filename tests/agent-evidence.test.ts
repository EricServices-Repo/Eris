import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Stage 4 of docs/reviews/eris-dev-10000-2026-10-23/AGENT-IMPROVEMENTS.md:
 * scope relevance, stack fit, context accounting and labeled cases (AG-043–051, AG-067).
 */

import { createTaskContract, detectProjectStack } from '../electron/main/services/task-intake'
import { compileTaskContext } from '../electron/main/services/agent/context-compiler'
import { requestInvariantFindings } from '../electron/main/services/agent/request-invariants'
import { evaluateScenario } from '../electron/main/services/debug-runs/oracle'
import { builtinDebugScenarios } from '../electron/main/services/debug-runs/scenarios'
import { interpretationOf } from '../src/shared/task-contract'
import { artifactResponseContract } from '../src/shared/task-interpretation'
import type { TurnPlan } from '../src/shared/settings-schema'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'eris-evidence-'))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

const SAMPLE = {
  'package.json': '{"name":"debug-fixture"}',
  'index.js': 'export function divide(a, b) { return a / b }\n'
}

const plan = (overrides: Partial<TurnPlan>): TurnPlan => ({
  intent: 'answer',
  agentId: 'explainer',
  agentName: 'Explainer',
  mode: 'agent',
  models: { chat: 'local:test', tools: 'local:test' },
  toolPolicy: 'none',
  requiresTools: false,
  escalateToFull: false,
  reason: 'test',
  method: 'heuristic',
  ...overrides
})

describe('AG-043/AG-045 resolved scope is not relevant scope', () => {
  it('marks an abstract example generic, with or without a project', () => {
    const text = 'Can you write a clear Java version of generating image thumbnails on the fly?'
    const withProject = createTaskContract({ workspacePath: project(SAMPLE), text, plan: plan({}) })
    const without = createTaskContract({ workspacePath: null, text, plan: plan({}) })
    for (const task of [withProject, without]) {
      expect(task.scope.applicability).toBe('generic')
      expect(interpretationOf(task)).toMatchObject({ artifact: 'code-example', language: 'Java' })
    }
    expect(withProject.authority).toEqual(without.authority)
    expect(artifactResponseContract(interpretationOf(withProject), 'generic')).toContain(
      'Do not cite its files'
    )
  })

  it('binds edits and project questions to the selected project', () => {
    const root = project(SAMPLE)
    expect(
      createTaskContract({
        workspacePath: root,
        text: 'Fix division by zero in index.js',
        plan: plan({ intent: 'edit', toolPolicy: 'edit', agentId: 'composer' })
      }).scope.applicability
    ).toBe('selected-project')
    expect(
      createTaskContract({
        workspacePath: root,
        text: 'How does division work in this project?',
        plan: plan({ intent: 'explore', toolPolicy: 'read' })
      }).scope.applicability
    ).toBe('selected-project')
  })
})

describe('AG-051 requested stack against the project stack', () => {
  it('detects project manifests and reports a mismatch', () => {
    const js = project({
      ...SAMPLE,
      'tsconfig.json': '{}',
      'package.json': '{"dependencies":{"react":"18"}}'
    })
    expect(detectProjectStack(js)).toEqual({ languages: ['TypeScript'], frameworks: ['React'] })
    const django = project({ 'manage.py': '', 'requirements.txt': 'Django==5.0\n' })
    expect(detectProjectStack(django)).toEqual({ languages: ['Python'], frameworks: ['Django'] })

    // LR-011: a generic request is not compared with the unrelated open project.
    const generic = createTaskContract({
      workspacePath: js,
      text: 'Can you write a clear Java version of generating image thumbnails on the fly?',
      plan: plan({})
    })
    expect(interpretationOf(generic).stackFit).toBe('not-applicable')
    expect(interpretationOf(generic).projectStack).toEqual({
      languages: ['TypeScript'],
      frameworks: ['React']
    })
    expect(
      artifactResponseContract(interpretationOf(generic), generic.scope.applicability)
    ).not.toContain('open project uses')
    // A request about this project still exposes the mismatch.
    const task = createTaskContract({
      workspacePath: js,
      text: 'Can you write a Java version of the thumbnail code in this project?',
      plan: plan({})
    })
    expect(task.scope.applicability).toBe('selected-project')
    expect(interpretationOf(task).stackFit).toBe('mismatch')
    expect(artifactResponseContract(interpretationOf(task), task.scope.applicability)).toContain(
      'answer in Java as requested'
    )
  })

  it('asks for an analogue when a concept belongs to another ecosystem', () => {
    const task = createTaskContract({
      workspacePath: null,
      text: 'Show me how to implement error boundaries that support retry in Rust',
      plan: plan({})
    })
    expect(interpretationOf(task).conceptFit).toEqual({
      concept: 'error boundaries',
      ecosystem: 'React',
      requestedLanguage: 'Rust'
    })
    expect(artifactResponseContract(interpretationOf(task))).toContain(
      'do not invent React APIs in Rust'
    )
    const ts = createTaskContract({
      workspacePath: null,
      text: 'Show me error boundaries that support retry in TypeScript',
      plan: plan({})
    })
    expect(interpretationOf(ts).conceptFit).toBeNull()
  })
})

describe('AG-048/AG-049 context accounting and admission', () => {
  const task = () =>
    createTaskContract({
      workspacePath: null,
      text: 'Do not edit anything; explain the cache layer',
      plan: plan({ intent: 'explore', toolPolicy: 'read' })
    })

  it('labels character estimates and reserves room for the conversation', () => {
    const { budget } = compileTaskContext({
      task: task(),
      guidance: 'g',
      project: '',
      retrieval: '',
      maxInputTokens: 4096
    })
    expect(budget).toMatchObject({ method: 'characters', tokenizer: 'none', charsPerToken: 3 })
    expect(budget.uncertainty).toMatch(/estimate/i)
    expect(budget.reservedForConversationTokens).toBeGreaterThan(budget.inputTokens / 3)
  })

  it.each([4096, 8192, 16384])(
    'trims evidence but never the task or instructions at %i tokens',
    (tokens) => {
      const compiled = compileTaskContext({
        task: task(),
        guidance: 'RULE: keep edits read-only.',
        project: 'x'.repeat(200_000),
        retrieval: 'lead '.repeat(10_000),
        maxInputTokens: tokens
      })
      const byKind = Object.fromEntries(compiled.blocks.map((block) => [block.kind, block]))
      expect(byKind.task?.status).toBe('included')
      expect(byKind.instructions?.status).toBe('included')
      expect(byKind.project?.status).toBe('truncated')
      expect(compiled.message.content).toContain('"forbidsMutation":true')
      expect(compiled.message.content).toContain('RULE: keep edits read-only.')
      expect(compiled.budget.usedChars).toBeLessThanOrEqual(compiled.budget.maxChars)
    }
  )

  it('fails clearly when mandatory input cannot fit', () => {
    expect(() =>
      compileTaskContext({
        task: task(),
        guidance: 'rule '.repeat(20_000),
        project: '',
        retrieval: '',
        maxInputTokens: 4096
      })
    ).toThrow(/exceed this model context/)
  })
})

describe('AG-062/AG-068 request invariants', () => {
  it('flags the review’s confirmed defects on a synthetic legacy request', () => {
    const task = createTaskContract({
      workspacePath: null,
      text: 'How would you design the data model and API for role-based access control?',
      plan: plan({ intent: 'capability' })
    })
    const legacy = {
      ...task,
      acceptanceCriteria: [
        'The requested behavior is implemented and verification results are reported.'
      ]
    }
    const ids = requestInvariantFindings({
      task: legacy,
      requests: [
        {
          purpose: 'agent',
          messages: [
            {
              role: 'system',
              content:
                'Shared rules (every role inherits these)\nShared rules (every role inherits these)\nMake the requested changes'
            }
          ],
          tools: []
        }
      ],
      imagesEnabled: false,
      mcpToolCount: 0
    }).map((finding) => finding.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'answer-requires-mutation',
        'domain-model-as-capability',
        'missing-task-contract',
        'tool-free-mutation-plan',
        'duplicate-shared-rules'
      ])
    )
  })
})

describe('AG-067 labeled expected outcomes', () => {
  const scenarios = builtinDebugScenarios()

  it('labels every corpus regression from the request, with an artifact expectation', () => {
    const corpus = scenarios.filter((scenario) => scenario.tags.includes('corpus-regression'))
    expect(corpus.map((scenario) => scenario.id).sort()).toEqual(
      [
        'complete-example-soft-delete',
        'data-model-infinite-scroll',
        'data-model-rbac',
        'data-model-transactional-email',
        'seed-data-not-verification'
      ].sort()
    )
    for (const scenario of corpus) {
      expect(scenario.label?.source).toBe('review-derived')
      expect(scenario.label?.rationale.length).toBeGreaterThan(20)
      expect(scenario.expect.artifact?.length).toBeGreaterThan(0)
    }
  })

  it('includes representative fixtures, including a wrong sibling project', () => {
    const fixtures = scenarios.filter((scenario) =>
      scenario.tags.includes('representative-fixture')
    )
    expect(fixtures.map((scenario) => scenario.id)).toEqual(
      expect.arrayContaining([
        'password-reset-review-grounded',
        'react-component-explained',
        'multi-project-named-target'
      ])
    )
    const multi = fixtures.find((scenario) => scenario.id === 'multi-project-named-target')!
    expect(Object.keys(multi.fixture)).toEqual(
      expect.arrayContaining(['apps/shop/src/cart.ts', 'apps/blog/src/cart.ts'])
    )
  })

  it('reports an artifact mismatch separately from intent', () => {
    const scenario = scenarios.find((item) => item.id === 'complete-example-soft-delete')!
    const checks = evaluateScenario({
      scenario,
      sandbox: tmpdir(),
      route: {
        expectedIntents: ['answer'],
        initialIntent: 'edit',
        semanticIntent: 'plan',
        intent: 'plan',
        agentId: 'planner',
        agentName: 'Plan',
        toolPolicy: 'read',
        method: 'heuristic',
        reason: '',
        chatModel: '',
        toolsModel: ''
      },
      contract: {
        deliverable: 'plan',
        authority: { tools: 'read', edit: false, execute: 'none', externalEffects: false },
        scopeState: 'resolved',
        acceptanceCriteria: [],
        artifact: 'plan'
      },
      terminal: 'complete',
      beforeWorkspace: {},
      changedPaths: [],
      answer: '1. Add a deletedAt column',
      steps: 1,
      durationMs: 1,
      toolErrors: 0,
      toolFailureCodes: [],
      toolsUsed: [],
      blockedEffects: []
    })
    const failed = checks.filter((item) => !item.ok).map((item) => item.category)
    expect(failed).toEqual(expect.arrayContaining(['intent_mismatch', 'artifact_mismatch']))
  })
})
